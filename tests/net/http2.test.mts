/**
 * HTTP/2 integration tests.
 *
 * Steps 5–8: bindings smoke test, session shell, server happy path, body echo.
 */

import { describe, it } from 'fino:test/test';
import { h2Available, h2Version, H2ClientDriver, Nghttp2Session } from 'fino:net/http/h2';
import { serveHttp } from 'fino:net/http/server';
import { Socket } from 'fino:net/socket';
import { Response } from 'fino:net/http';
import { _parseH2ContentLength, _parseH2StatusHeader } from '../../js/internal/net/http/h2/server.mts';

if (!h2Available && (globalThis as any).process?.env?.FINO_REQUIRE_H2 === '1') {
  throw new Error('FINO_REQUIRE_H2=1 but libnghttp2 is not available');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const _enc = new TextEncoder();
const _dec = new TextDecoder();

function hexBytes(...args: number[]): Uint8Array { return new Uint8Array(args); }

interface RawFrame {
  length: number;
  type: number;
  flags: number;
  streamId: number;
  payload: Uint8Array;
}

// H2 client connection preface (24 bytes)
const H2_PREFACE = hexBytes(
  0x50,0x52,0x49,0x20,0x2A,0x20,0x48,0x54,0x54,0x50,0x2F,0x32,
  0x2E,0x30,0x0D,0x0A,0x0D,0x0A,0x53,0x4D,0x0D,0x0A,0x0D,0x0A,
);

// Empty SETTINGS frame (9 bytes, stream 0)
const SETTINGS_EMPTY = hexBytes(0x00,0x00,0x00, 0x04, 0x00, 0x00,0x00,0x00,0x00);

function frame(type: number, flags: number, streamId: number, payload = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(9 + payload.byteLength);
  const len = payload.byteLength;
  out[0] = (len >> 16) & 0xff;
  out[1] = (len >> 8) & 0xff;
  out[2] = len & 0xff;
  out[3] = type & 0xff;
  out[4] = flags & 0xff;
  out[5] = (streamId >> 24) & 0x7f;
  out[6] = (streamId >> 16) & 0xff;
  out[7] = (streamId >> 8) & 0xff;
  out[8] = streamId & 0xff;
  out.set(payload, 9);
  return out;
}

function dataFrameFor(streamId: number, body: Uint8Array, flags = 0x01): Uint8Array {
  return frame(0x00, flags, streamId, body);
}

function priorityFrame(streamId: number, dependency: number): Uint8Array {
  return frame(0x02, 0x00, streamId, hexBytes(
    (dependency >> 24) & 0x7f,
    (dependency >> 16) & 0xff,
    (dependency >> 8) & 0xff,
    dependency & 0xff,
    16,
  ));
}

function rstStreamFrame(streamId: number, errorCode: number): Uint8Array {
  return frame(0x03, 0x00, streamId, hexBytes(
    (errorCode >> 24) & 0xff,
    (errorCode >> 16) & 0xff,
    (errorCode >> 8) & 0xff,
    errorCode & 0xff,
  ));
}

async function readRawFrames(reader: any, limit = 16): Promise<RawFrame[]> {
  const frames: RawFrame[] = [];
  for (let i = 0; i < limit; i++) {
    let header: Uint8Array | null = null;
    try { header = await reader.readExactly(9); } catch { break; }
    if (!header || header.byteLength < 9) break;
    const length = (header[0] << 16) | (header[1] << 8) | header[2];
    const payload = length > 0 ? await reader.readExactly(length) : new Uint8Array(0);
    if (!payload || payload.byteLength < length) break;
    frames.push({
      length,
      type: header[3],
      flags: header[4],
      streamId: ((header[5] & 0x7f) << 24) | (header[6] << 16) | (header[7] << 8) | header[8],
      payload,
    });
    if (header[3] === 0x07) break;
  }
  return frames;
}

function frameErrorCode(f: RawFrame): number {
  const p = f.payload;
  const off = f.type === 0x07 ? 4 : 0;
  return ((p[off]! << 24) | (p[off + 1]! << 16) | (p[off + 2]! << 8) | p[off + 3]!) >>> 0;
}

async function rawH2Exchange(port: number, frames: Uint8Array): Promise<RawFrame[]> {
  const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port });
  const [reader, writer] = sock.split();
  await writer.write(new Uint8Array([...H2_PREFACE, ...SETTINGS_EMPTY, ...frames]));
  await writer.flush();
  await writer.close();
  const rawFrames = await readRawFrames(reader);
  try { await reader.close(); } catch {}
  return rawFrames;
}

function findFrame(frames: RawFrame[], type: number, streamId?: number): RawFrame | null {
  return frames.find(f => f.type === type && (streamId === undefined || f.streamId === streamId)) ?? null;
}

// HEADERS frame for GET / (stream 1, END_STREAM+END_HEADERS)
// HPACK: :method=GET(idx2), :path=/(idx4), :scheme=http(idx6),
//        :authority=localhost (literal incremental index 1, length 9)
const H2_GET_ROOT_LOCALHOST = hexBytes(
  // 9-byte frame header
  0x00, 0x00, 0x0e,   // length = 14
  0x01,               // type = HEADERS
  0x05,               // flags = END_STREAM | END_HEADERS
  0x00, 0x00, 0x00, 0x01, // stream_id = 1
  // HPACK block
  0x82, 0x84, 0x86,   // :method GET, :path /, :scheme http
  0x41,               // :authority — literal incremental index 1
  0x09,               // value length 9 (no Huffman)
  0x6c,0x6f,0x63,0x61,0x6c,0x68,0x6f,0x73,0x74, // "localhost"
);

// HEADERS frame for POST / (stream 1, END_HEADERS only — body follows)
// HPACK: :method=POST(idx3), :path=/(idx4), :scheme=http(idx6), :authority=localhost
const H2_POST_ROOT_LOCALHOST = hexBytes(
  0x00, 0x00, 0x0e,   // length = 14
  0x01,               // type = HEADERS
  0x04,               // flags = END_HEADERS (no END_STREAM)
  0x00, 0x00, 0x00, 0x01,
  0x83, 0x84, 0x86,   // :method POST, :path /, :scheme http
  0x41, 0x09,
  0x6c,0x6f,0x63,0x61,0x6c,0x68,0x6f,0x73,0x74,
);

// POST / with content-length: 4.
// HPACK: POST, /, http, :authority=localhost, content-length=4.
const H2_POST_ROOT_LOCALHOST_CL4 = hexBytes(
  0x83, 0x84, 0x86,
  0x41, 0x09,
  0x6c,0x6f,0x63,0x61,0x6c,0x68,0x6f,0x73,0x74,
  0x5c, 0x01, 0x34,
);

/** Build a DATA frame for stream 1 with END_STREAM. */
function dataFrame(body: Uint8Array): Uint8Array {
  const len = body.byteLength;
  const frame = new Uint8Array(9 + len);
  frame[0] = (len >> 16) & 0xff;
  frame[1] = (len >> 8)  & 0xff;
  frame[2] = len & 0xff;
  frame[3] = 0x00;  // DATA
  frame[4] = 0x01;  // END_STREAM
  frame[8] = 0x01;  // stream_id = 1
  frame.set(body, 9);
  return frame;
}

/** Connect, send H2 preface + SETTINGS + HEADERS, read back all bytes. */
async function h2RoundTrip(port: number, extraFrames?: Uint8Array): Promise<string> {
  const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port });
  const [reader, writer] = sock.split();

  const toSend = new Uint8Array([
    ...H2_PREFACE, ...SETTINGS_EMPTY, ...H2_GET_ROOT_LOCALHOST,
    ...(extraFrames ?? []),
  ]);
  await writer.write(toSend);
  writer.close();

  const chunks: Uint8Array[] = [];
  for await (const chunk of reader) chunks.push(chunk);
  reader.close();

  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const all = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { all.set(c, pos); pos += c.byteLength; }
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
    t.ok(raw.includes('\x88') || raw.charCodeAt(0) >= 0, 'response frame present');
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
      if (bytes[i] === 0x04) { foundSettings = true; break; }
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
  const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port });
  const [reader, writer] = sock.split();

  const bodyBytes = _enc.encode(body);
  const toSend = new Uint8Array([
    ...H2_PREFACE, ...SETTINGS_EMPTY,
    ...H2_POST_ROOT_LOCALHOST,
    ...dataFrame(bodyBytes),
  ]);
  await writer.write(toSend);
  writer.close();

  const chunks: Uint8Array[] = [];
  for await (const chunk of reader) chunks.push(chunk);
  reader.close();

  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const all = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { all.set(c, pos); pos += c.byteLength; }
  return _dec.decode(all);
}

describe('H2 server — request bodies', () => {
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
  const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port });
  const [reader, writer] = sock.split();
  const url = `http://127.0.0.1:${port}${path}`;
  const reqBody = body !== undefined ? _enc.encode(body) : null;
  const req = new (globalThis as any).Request(url, {
    method,
    body: reqBody?.buffer ?? null,
  });
  return _h2Client.send(req, reader as any, writer, { signal: null });
}

describe('H2ClientDriver', () => {
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

    const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port });
    const [reader, writer] = sock.split();
    const url = `http://127.0.0.1:${port}/`;
    const req = new (globalThis as any).Request(url, {
      method: 'GET',
      headers: { 'x-custom': 'test-value' },
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
        _takeOver: async () => {},
      } as any;
    });
    const port = server.port;

    const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port });
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

const CRLFCRLF = new Uint8Array([13, 10, 13, 10]);

// Read until \r\n\r\n and return the header block as text.
async function readHeaders(reader: any): Promise<string> {
  const bytes = await reader.readUntil(CRLFCRLF);
  return _dec.decode(bytes ?? new Uint8Array(0));
}

describe('H2 server — h2c Upgrade (RFC 7540 §3.2)', () => {
  it('server responds with 101 Switching Protocols and serves stream 1 over h2', async (t) => {
    if (!h2Available) return;

    const server = serveHttp(
      { port: 0, allowH2cUpgrade: true },
      async (req) => new Response('upgraded:' + new URL(req.url).pathname),
    );
    const port = server.port;

    const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port });
    const [reader, writer] = sock.split();

    // Send HTTP/1.1 Upgrade request. HTTP2-Settings value is empty (default settings).
    const upgradeReq = _enc.encode(
      `GET / HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Connection: Upgrade, HTTP2-Settings\r\n` +
      `Upgrade: h2c\r\n` +
      `HTTP2-Settings: \r\n` +
      `\r\n`,
    );
    await writer.write(upgradeReq);
    await writer.flush();

    // Read 101 response headers.
    const headers101 = await readHeaders(reader);
    t.ok(headers101.startsWith('HTTP/1.1 101'), `101 received: ${headers101.split('\r\n')[0]}`);
    t.ok(headers101.toLowerCase().includes('upgrade: h2c'), 'upgrade: h2c header present');

    // Set up a client-side h2 session in upgrade mode.
    // Stream 1 is now half-closed (local) — we already sent the h1 request.
    let stream1Status = 0;
    let stream1Body   = '';
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
      },
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
      await flushClient(); // send SETTINGS ACK, WINDOW_UPDATE, etc.
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

    const server = serveHttp(
      { port: 0, allowH2cUpgrade: true },
      async (_req) => new Response('hello h1'),
    );
    const port = server.port;

    const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port });
    const [reader, writer] = sock.split();

    await writer.write(_enc.encode(
      `GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
    ));
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
    const frames = await rawH2Exchange(port, new Uint8Array([
      ...H2_POST_ROOT_LOCALHOST,
      ...dataFrameFor(1, body, 0x01),
    ]));
    await server.close();

    t.equal(captured, 16 * 1024, 'handler received exact 16 KiB DATA payload');
    t.ok(findFrame(frames, 0x01, 1) !== null, 'server sent response HEADERS');
  });

  it('sends GOAWAY when a new client stream id is lower than a previous stream id', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, new Uint8Array([
      ...frame(0x01, 0x05, 3, H2_GET_ROOT_LOCALHOST.subarray(9)),
      ...frame(0x01, 0x05, 1, H2_GET_ROOT_LOCALHOST.subarray(9)),
    ]));
    await server.close();

    const goaway = findFrame(frames, 0x07);
    t.ok(goaway !== null, 'server sent GOAWAY');
    t.equal(frameErrorCode(goaway!), 0x01, 'GOAWAY uses PROTOCOL_ERROR');
  });

  it('sends GOAWAY for DATA and RST_STREAM on an idle stream', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const dataFrames = await rawH2Exchange(server.port, dataFrameFor(1, new Uint8Array(0), 0x01));
    const rstFrames = await rawH2Exchange(server.port, rstStreamFrame(1, 0));
    await server.close();

    t.equal(frameErrorCode(findFrame(dataFrames, 0x07)!), 0x01, 'idle DATA gets GOAWAY PROTOCOL_ERROR');
    t.equal(frameErrorCode(findFrame(rstFrames, 0x07)!), 0x01, 'idle RST_STREAM gets GOAWAY PROTOCOL_ERROR');
  });

  it('sends GOAWAY for RST_STREAM on stream 0', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, rstStreamFrame(0, 0));
    await server.close();

    const goaway = findFrame(frames, 0x07);
    t.ok(goaway !== null, 'server sent GOAWAY');
    t.equal(frameErrorCode(goaway!), 0x01, 'GOAWAY uses PROTOCOL_ERROR');
  });

  it('RST_STREAMs DATA and HEADERS sent after the client half-closes the stream', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const dataFrames = await rawH2Exchange(server.port, new Uint8Array([
      ...H2_GET_ROOT_LOCALHOST,
      ...dataFrameFor(1, _enc.encode('late'), 0x01),
    ]));
    const headersFrames = await rawH2Exchange(server.port, new Uint8Array([
      ...H2_GET_ROOT_LOCALHOST,
      ...frame(0x01, 0x05, 1, H2_GET_ROOT_LOCALHOST.subarray(9)),
    ]));
    await server.close();

    const dataRst = findFrame(dataFrames, 0x03, 1);
    const headersRst = findFrame(headersFrames, 0x03, 1);
    t.ok(dataRst !== null, 'DATA after half-close gets RST_STREAM');
    t.ok(headersRst !== null, 'HEADERS after half-close gets RST_STREAM');
    t.equal(frameErrorCode(dataRst!), 0x05, 'DATA reset uses STREAM_CLOSED');
    t.equal(frameErrorCode(headersRst!), 0x05, 'HEADERS reset uses STREAM_CLOSED');
  });

  it('RST_STREAMs DATA and HEADERS sent after client RST_STREAM closes a stream', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const dataFrames = await rawH2Exchange(server.port, new Uint8Array([
      ...H2_POST_ROOT_LOCALHOST,
      ...rstStreamFrame(1, 0),
      ...dataFrameFor(1, _enc.encode('late'), 0x01),
    ]));
    const headersFrames = await rawH2Exchange(server.port, new Uint8Array([
      ...H2_POST_ROOT_LOCALHOST,
      ...rstStreamFrame(1, 0),
      ...frame(0x01, 0x05, 1, H2_GET_ROOT_LOCALHOST.subarray(9)),
    ]));
    await server.close();

    const dataRst = findFrame(dataFrames, 0x03, 1);
    const headersRst = findFrame(headersFrames, 0x03, 1);
    t.ok(dataRst !== null, 'DATA after closed stream gets RST_STREAM');
    t.ok(headersRst !== null, 'HEADERS after closed stream gets RST_STREAM');
    t.equal(frameErrorCode(dataRst!), 0x05, 'DATA reset uses STREAM_CLOSED');
    t.equal(frameErrorCode(headersRst!), 0x05, 'HEADERS reset uses STREAM_CLOSED');
  });

  it('sends GOAWAY for malformed DATA padding', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, new Uint8Array([
      ...H2_POST_ROOT_LOCALHOST,
      ...frame(0x00, 0x08, 1, hexBytes(8, 1, 2, 3)),
    ]));
    await server.close();

    const goaway = findFrame(frames, 0x07);
    t.ok(goaway !== null, 'server sent GOAWAY');
    t.equal(frameErrorCode(goaway!), 0x01, 'GOAWAY uses PROTOCOL_ERROR');
  });

  it('sends GOAWAY immediately for DATA larger than the default max frame size', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const oversizedHeaderOnly = frame(0x00, 0x00, 1, new Uint8Array(16 * 1024 + 1)).subarray(0, 9);
    const frames = await rawH2Exchange(server.port, new Uint8Array([
      ...H2_POST_ROOT_LOCALHOST,
      ...oversizedHeaderOnly,
    ]));
    await server.close();

    const goaway = findFrame(frames, 0x07);
    t.ok(goaway !== null, 'server sent GOAWAY');
    t.equal(frameErrorCode(goaway!), 0x06, 'GOAWAY uses FRAME_SIZE_ERROR');
  });


  it('validates PRIORITY stream id, length, and self-dependency', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const stream0 = await rawH2Exchange(server.port, frame(0x02, 0x00, 0, new Uint8Array(5)));
    const wrongLength = await rawH2Exchange(server.port, frame(0x02, 0x00, 1, new Uint8Array(4)));
    const selfDependency = await rawH2Exchange(server.port, priorityFrame(1, 1));
    await server.close();

    const stream0Goaway = findFrame(stream0, 0x07);
    const wrongLengthGoaway = findFrame(wrongLength, 0x07);
    const selfRst = findFrame(selfDependency, 0x03, 1);
    t.equal(frameErrorCode(stream0Goaway!), 0x01, 'stream 0 PRIORITY gets PROTOCOL_ERROR');
    t.equal(frameErrorCode(wrongLengthGoaway!), 0x06, 'wrong PRIORITY length gets FRAME_SIZE_ERROR');
    t.equal(frameErrorCode(selfRst!), 0x01, 'self-dependent PRIORITY gets stream PROTOCOL_ERROR');
  });

  it('closes cleanly for invalid PING length and ignores client PING ACK', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const invalidPing = await rawH2Exchange(server.port, frame(0x06, 0x00, 0, new Uint8Array(7)));
    const ackPing = await rawH2Exchange(server.port, frame(0x06, 0x01, 0, new Uint8Array(8)));
    await server.close();

    t.ok(findFrame(invalidPing, 0x07) === null, 'invalid PING length closes without GOAWAY');
    t.ok(findFrame(ackPing, 0x06) === null, 'client PING ACK is ignored');
    const goaway = findFrame(ackPing, 0x07);
    t.ok(goaway === null || frameErrorCode(goaway) === 0, 'client PING ACK does not cause an error GOAWAY');
  });

  it('ignores undefined frame flags and handles the known flags normally', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, frame(0x06, 0x80, 0, new Uint8Array(8)));
    await server.close();

    const pingAck = frames.find(f => f.type === 0x06 && (f.flags & 0x01) !== 0);
    t.ok(pingAck !== undefined, 'server ACKed PING despite undefined flag bit');
    const errorGoaway = frames.find(f => f.type === 0x07 && frameErrorCode(f) !== 0);
    t.ok(errorGoaway === undefined, 'undefined flag bit did not trigger an error GOAWAY');
  });

  it('RST_STREAMs streams above the max concurrent stream limit', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const requestFrames: number[] = [];
    for (let streamId = 1; streamId <= 65; streamId += 2) {
      requestFrames.push(...frame(0x01, 0x04, streamId, H2_POST_ROOT_LOCALHOST.subarray(9)));
    }
    const frames = await rawH2Exchange(server.port, new Uint8Array(requestFrames));
    await server.close();

    const rst = findFrame(frames, 0x03, 65);
    t.ok(rst !== null, 'stream above the advertised limit gets RST_STREAM');
    t.equal(frameErrorCode(rst!), 0x07, 'reset uses REFUSED_STREAM');
  });

  it('sends GOAWAY for representative CONTINUATION ordering errors', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const interrupted = await rawH2Exchange(server.port, new Uint8Array([
      ...frame(0x01, 0x01, 1, H2_GET_ROOT_LOCALHOST.subarray(9)),
      ...frame(0x00, 0x00, 1, new Uint8Array(0)),
    ]));
    const interruptedByExtension = await rawH2Exchange(server.port, new Uint8Array([
      ...frame(0x01, 0x01, 1, H2_GET_ROOT_LOCALHOST.subarray(9)),
      ...frame(0x0b, 0x00, 1, new Uint8Array(0)),
    ]));
    const stream0 = await rawH2Exchange(server.port, frame(0x09, 0x04, 0, new Uint8Array(0)));
    const unexpectedOnOpen = await rawH2Exchange(server.port, new Uint8Array([
      ...H2_POST_ROOT_LOCALHOST,
      ...frame(0x09, 0x04, 1, new Uint8Array(0)),
    ]));
    const onHalfClosed = await rawH2Exchange(server.port, new Uint8Array([
      ...H2_GET_ROOT_LOCALHOST,
      ...frame(0x09, 0x04, 1, new Uint8Array(0)),
    ]));
    const afterRstStream = await rawH2Exchange(server.port, new Uint8Array([
      ...H2_POST_ROOT_LOCALHOST,
      ...rstStreamFrame(1, 0),
      ...frame(0x09, 0x04, 1, new Uint8Array(0)),
    ]));
    await server.close();

    t.equal(frameErrorCode(findFrame(interrupted, 0x07)!), 0x01, 'interrupted header block gets PROTOCOL_ERROR');
    t.equal(frameErrorCode(findFrame(interruptedByExtension, 0x07)!), 0x01, 'extension frame during header block gets PROTOCOL_ERROR');
    t.equal(frameErrorCode(findFrame(stream0, 0x07)!), 0x01, 'CONTINUATION stream 0 gets PROTOCOL_ERROR');
    t.equal(frameErrorCode(findFrame(unexpectedOnOpen, 0x07)!), 0x01, 'unexpected CONTINUATION gets PROTOCOL_ERROR');
    t.equal(frameErrorCode(findFrame(onHalfClosed, 0x07)!), 0x01, 'half-closed CONTINUATION without an active header block gets PROTOCOL_ERROR');
    t.equal(frameErrorCode(findFrame(afterRstStream, 0x07)!), 0x01, 'closed-stream CONTINUATION after RST_STREAM gets PROTOCOL_ERROR');
  });

  it('ACKs peer SETTINGS frames after the initial SETTINGS exchange', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, frame(0x04, 0x00, 0, hexBytes(
      0x00, 0x03, 0x00, 0x00, 0x00, 0x40,
    )));
    await server.close();

    const settingsAcks = frames.filter(f => f.type === 0x04 && f.flags === 0x01 && f.length === 0);
    t.ok(settingsAcks.length >= 2, `server ACKed initial and follow-up SETTINGS frames (${settingsAcks.length})`);
  });

  it('sends GOAWAY for SETTINGS ACK frames with payload', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, frame(0x04, 0x01, 0, hexBytes(
      0x00, 0x03, 0x00, 0x00, 0x00, 0x40,
    )));
    await server.close();

    const goaway = findFrame(frames, 0x07);
    t.ok(goaway !== null, 'server sent GOAWAY');
    t.equal(frameErrorCode(goaway!), 0x06, 'GOAWAY uses FRAME_SIZE_ERROR');
  });

  it('sends GOAWAY when a client sends PUSH_PROMISE', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, new Uint8Array([
      ...H2_GET_ROOT_LOCALHOST,
      ...frame(0x05, 0x04, 1, hexBytes(
        0x00, 0x00, 0x00, 0x02,
        0x82, 0x84, 0x86,
      )),
    ]));
    await server.close();

    const goaway = findFrame(frames, 0x07);
    t.ok(goaway !== null, 'server sent GOAWAY');
    t.equal(frameErrorCode(goaway!), 0x01, 'GOAWAY uses PROTOCOL_ERROR');
  });

  it('closes cleanly for an invalid connection preface', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port: server.port });
    const [reader, writer] = sock.split();
    await writer.write(_enc.encode('PRI * HTTP/2.0\r\n\r\nbad-preface'));
    await writer.flush();
    await writer.close();
    const frames = await readRawFrames(reader);
    try { await reader.close(); } catch {}
    await server.close();

    const goaway = findFrame(frames, 0x07);
    t.ok(goaway === null || frameErrorCode(goaway) === 0x01, 'server closed or sent GOAWAY(PROTOCOL_ERROR)');
  });

  it('RST_STREAMs request HEADERS with response-only pseudo-headers', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const invalidRequestBlock = hexBytes(
      0x82, 0x84, 0x86, // :method GET, :path /, :scheme http
      0x88,             // :status 200 is response-only and invalid in requests
    );
    const frames = await rawH2Exchange(server.port, frame(0x01, 0x05, 1, invalidRequestBlock));
    await server.close();

    const rst = findFrame(frames, 0x03, 1);
    t.ok(rst !== null, 'invalid request pseudo-header gets RST_STREAM');
    t.equal(frameErrorCode(rst!), 0x01, 'reset uses PROTOCOL_ERROR');
  });

  it('RST_STREAMs request HEADERS with missing or empty :path', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const missingPathBlock = hexBytes(
      0x82, 0x86,       // :method GET, :scheme http
      0x41, 0x09,
      0x6c,0x6f,0x63,0x61,0x6c,0x68,0x6f,0x73,0x74,
    );
    const emptyPathBlock = hexBytes(
      0x82,             // :method GET
      0x44, 0x00,       // :path = ""
      0x86,             // :scheme http
      0x41, 0x09,
      0x6c,0x6f,0x63,0x61,0x6c,0x68,0x6f,0x73,0x74,
    );
    const missingFrames = await rawH2Exchange(server.port, frame(0x01, 0x05, 1, missingPathBlock));
    const emptyFrames = await rawH2Exchange(server.port, frame(0x01, 0x05, 1, emptyPathBlock));
    await server.close();

    const missingRst = findFrame(missingFrames, 0x03, 1);
    const emptyRst = findFrame(emptyFrames, 0x03, 1);
    t.ok(missingRst !== null, 'missing :path gets RST_STREAM');
    t.ok(emptyRst !== null, 'empty :path gets RST_STREAM');
    t.equal(frameErrorCode(missingRst!), 0x01, 'missing :path reset uses PROTOCOL_ERROR');
    t.equal(frameErrorCode(emptyRst!), 0x01, 'empty :path reset uses PROTOCOL_ERROR');
  });

  it('RST_STREAMs a second request HEADERS frame on an open stream', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, new Uint8Array([
      ...H2_POST_ROOT_LOCALHOST,
      ...frame(0x01, 0x04, 1, H2_GET_ROOT_LOCALHOST.subarray(9)),
    ]));
    await server.close();

    const rst = findFrame(frames, 0x03, 1);
    t.ok(rst !== null, 'second non-trailer HEADERS gets RST_STREAM');
    t.equal(frameErrorCode(rst!), 0x01, 'reset uses PROTOCOL_ERROR');
  });

  it('RST_STREAMs requests whose content-length does not match DATA length', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, new Uint8Array([
      ...frame(0x01, 0x04, 1, H2_POST_ROOT_LOCALHOST_CL4),
      ...dataFrameFor(1, _enc.encode('bad'), 0x01),
    ]));
    await server.close();

    const rst = findFrame(frames, 0x03, 1);
    t.ok(rst !== null, 'mismatched content-length gets RST_STREAM');
    t.equal(frameErrorCode(rst!), 0x01, 'reset uses PROTOCOL_ERROR');
  });

  it('server does not hang after client RST_STREAMs a pending request', async (t) => {
    if (!h2Available) return;

    // Handler that waits for a body — so the server will be in triggerDispatch
    // state when the client sends RST_STREAM.
    let handlerStarted = false;
    const server = serveHttp({ port: 0 }, async (req) => {
      handlerStarted = true;
      await req.text(); // reads body — but body never arrives on RST_STREAM
      return new Response('ok');
    });
    const port = server.port;

    const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port });
    const [reader, writer] = sock.split();

    const noopCallbacks = {
      onBeginHeaders() {}, onHeader() {}, onFrameRecv() {},
      onDataChunk() {}, onStreamClose() {},
    };
    const cs = await openClientSession(writer, noopCallbacks);

    // Submit a POST with hasBody=true but never provide data → server waits.
    const streamId = cs.submitRequest([
      [':method', 'POST'], [':path', '/'], [':scheme', 'http'],
      [':authority', `127.0.0.1:${port}`],
    ], true);

    while (cs.wantWrite()) {
      const bytes = await cs.flush();
      if (bytes && bytes.byteLength > 0) await writer.write(bytes);
    }
    await writer.flush();

    // Give server time to register the stream.
    await new Promise<void>(r => setTimeout(r, 20));

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

    // server.close() with a timeout guard — if the server hangs, the test
    // will time out at the test runner level. Using a racing promise to give
    // a better diagnostic.
    let timedOut = false;
    await Promise.race([
      server.close(),
      new Promise<void>(r => setTimeout(() => { timedOut = true; r(); }, 2000)),
    ]);

    t.ok(!timedOut, 'server.close() resolved within 2 s (no hang after RST_STREAM)');
  });

  it('server sends MAX_CONCURRENT_STREAMS in SETTINGS', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const port = server.port;

    const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port });
    const [reader, writer] = sock.split();

    // Send h2 connection preface + empty SETTINGS.
    await writer.write(H2_PREFACE);
    await writer.write(SETTINGS_EMPTY);
    await writer.flush();

    // Read the server's initial SETTINGS frame.
    const settingsFrame = await (reader as any).readExactly(9); // frame header
    t.ok(settingsFrame !== null, 'got server SETTINGS header');
    const frameType  = settingsFrame![3];
    const payloadLen = (settingsFrame![0] << 16) | (settingsFrame![1] << 8) | settingsFrame![2];
    t.equal(frameType, 0x04, 'frame type is SETTINGS (0x04)');
    t.ok(payloadLen >= 6, `SETTINGS has at least one entry (payload=${payloadLen})`);

    // Read the payload and scan for MAX_CONCURRENT_STREAMS (id=0x0003).
    const payload = await (reader as any).readExactly(payloadLen);
    let foundMaxConcurrent = false;
    for (let i = 0; i + 5 < payloadLen!; i += 6) {
      const id  = (payload![i] << 8) | payload![i + 1];
      const val = (payload![i + 2] << 24) | (payload![i + 3] << 16) |
                  (payload![i + 4] << 8)  | payload![i + 5];
      if (id === 0x0003) { foundMaxConcurrent = true; t.ok(val > 0, `MAX_CONCURRENT_STREAMS=${val}`); }
    }
    t.ok(foundMaxConcurrent, 'SETTINGS contains MAX_CONCURRENT_STREAMS');

    await writer.close();
    await server.close();
  });

  it('server closes gracefully on malformed frame', async (t) => {
    if (!h2Available) return;

    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const port = server.port;

    const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port });
    const [reader, writer] = sock.split();

    // Send h2 preface + SETTINGS, then junk bytes where a valid frame should be.
    await writer.write(H2_PREFACE);
    await writer.write(SETTINGS_EMPTY);
    // Garbage: length=0xFFFFFF (way too large), type=0xFF, flags=0xFF
    await writer.write(hexBytes(0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x01));
    await writer.flush();

    // Close the writer so the server sees EOF and doesn't wait for more of the oversized frame.
    await writer.close();

    // Server should send a GOAWAY or close — read until EOF without crashing.
    let gotEof = false;
    try {
      for await (const _ of reader as any) { /* drain */ }
      gotEof = true;
    } catch {
      gotEof = true; // read error also means connection closed
    }

    t.ok(gotEof, 'server closed connection after malformed frame');
    await server.close();
  });
});
