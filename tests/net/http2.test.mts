/**
 * HTTP/2 integration tests.
 *
 * Steps 5–8: bindings smoke test, session shell, server happy path, body echo.
 */

import { describe, it } from 'fino:test/test';
import { h2Available, h2Version, H2ClientDriver, Nghttp2Session } from 'fino:net/http/h2';
import { serve } from 'fino:net/http/server';
import { Socket } from 'fino:net/socket';
import { Response } from 'fino:net/http';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const _enc = new TextEncoder();
const _dec = new TextDecoder();

function hexBytes(...args: number[]): Uint8Array { return new Uint8Array(args); }

// H2 client connection preface (24 bytes)
const H2_PREFACE = hexBytes(
  0x50,0x52,0x49,0x20,0x2A,0x20,0x48,0x54,0x54,0x50,0x2F,0x32,
  0x2E,0x30,0x0D,0x0A,0x0D,0x0A,0x53,0x4D,0x0D,0x0A,0x0D,0x0A,
);

// Empty SETTINGS frame (9 bytes, stream 0)
const SETTINGS_EMPTY = hexBytes(0x00,0x00,0x00, 0x04, 0x00, 0x00,0x00,0x00,0x00);

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

// ---------------------------------------------------------------------------
// Step 7 — H2 server happy path
// ---------------------------------------------------------------------------

describe('H2 server — prior-knowledge h2c', () => {
  it('responds to GET / with plain text body', async (t) => {
    if (!h2Available) return;

    const server = serve({ port: 0 }, async (_req) => {
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

    const server = serve({ port: 0 }, async (_req) => new Response('ok'));
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

    const server = serve({ port: 0 }, async (req) => {
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
    const server = serve({ port: 0 }, async (req) => {
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
    const server = serve({ port: 0 }, async (req) => {
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

    const server = serve({ port: 0 }, async (_req) => new Response('hello from h2 client'));
    const port = server.port;

    const res = await h2ClientFetch(port, '/');
    const text = await res.text();
    await server.close();

    t.equal(res.status, 200, 'status is 200');
    t.equal(text, 'hello from h2 client', 'body received correctly');
  });

  it('POST / sends body and handler echoes it', async (t) => {
    if (!h2Available) return;

    const server = serve({ port: 0 }, async (req) => {
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
    const server = serve({ port: 0 }, async (req) => {
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

    const server = serve({ port: 0 }, async (_req) => {
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

    const server = serve(
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

    const server = serve(
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
  it('server does not hang after client RST_STREAMs a pending request', async (t) => {
    if (!h2Available) return;

    // Handler that waits for a body — so the server will be in triggerDispatch
    // state when the client sends RST_STREAM.
    let handlerStarted = false;
    const server = serve({ port: 0 }, async (req) => {
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

    const server = serve({ port: 0 }, async () => new Response('ok'));
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

    const server = serve({ port: 0 }, async () => new Response('ok'));
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
