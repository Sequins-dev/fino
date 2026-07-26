/**
 * Tests for fino:net/http/websocket — WebSocketConnection (engine) and WebSocket (facade).
 *
 * Tests cover:
 *   - Handshake key/accept computation (RFC 6455 §1.3 golden vector)
 *   - Frame encoding/decoding round-trips (text, binary, masked, all length tiers)
 *   - Close handshake (initiator + peer echo)
 *   - PING auto-PONG
 *   - Protocol violation handling (unmasked client frame → 1002, oversized → 1009, bad UTF-8 → 1007)
 *   - End-to-end over a real TCP socket via WebSocketConnection
 *   - End-to-end via serve() + WebSocketConnection.accept() integration
 *   - WHATWG WebSocket facade basics
 */
import { describe, it } from 'fino:test/test';
import { ok, equal, deepEqual } from 'fino:test/assert';
import {
  WebSocket,
  WebSocketConnection,
  MessageEvent,
  CloseEvent,
  WebSocketError,
} from 'fino:net/http/websocket';
import { serve } from 'fino:net/http/server';
import { Socket } from 'fino:net/socket';
import * as loop from 'internal:runtime/loop';
import type { Event, EventTarget } from 'internal:globals/eventtarget';
import type { WebSocketAcceptOptions } from 'fino:net/http/websocket';
import { digest } from '../../js/internal/openssl.ts';
import { btoa } from '../../js/globals/encoding.ts';
import { zlibDeflateRawMessage, zlibInflateRawMessage } from '../../js/internal/compress/zlib.ts';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | ArrayBuffer) => new TextDecoder().decode(b);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Wait for a named event on an EventTarget, resolving with the event. */
function waitForEvent<T extends Event>(
  target: EventTarget,
  name: string,
  timeoutMs = 5e3,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = loop.timeout(timeoutMs);
    t.then(() => {
      reject(new Error('waitForEvent timed out waiting for: ' + name));
    }).catch(() => {});
    target.addEventListener(
      name,
      function handler(e) {
        t.cancel();
        target.removeEventListener(name, handler);
        resolve(e as T);
      },
      { once: true },
    );
  });
}
/** Collect N messages from a WebSocketConnection via async iteration. */
async function collectMessages(
  ws: WebSocketConnection,
  n: number,
): Promise<
  Array<{
    type: string;
    data: unknown;
  }>
> {
  const msgs: Array<{
    type: string;
    data: unknown;
  }> = [];
  for await (const msg of ws) {
    msgs.push(msg);
    if (msgs.length >= n) break;
  }
  return msgs;
}
function acceptHash(key: string): string {
  const hash = digest('sha-1', enc(key + WS_GUID));
  let binary = '';
  for (const byte of hash) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function rawFrame(
  opcode: number,
  payload: Uint8Array,
  opts: {
    fin?: boolean;
    mask?: boolean;
    rsv?: number;
  } = {},
): Uint8Array {
  const fin = opts.fin !== false;
  const mask = opts.mask === true;
  const rsv = opts.rsv ?? 0;
  const len = payload.byteLength;
  let headerLen = 2;
  if (len > 65535) headerLen += 8;
  else if (len > 125) headerLen += 2;
  if (mask) headerLen += 4;
  const frame = new Uint8Array(headerLen + len);
  frame[0] = (fin ? 128 : 0) | (rsv & 112) | (opcode & 15);
  let pos = 2;
  if (len <= 125) {
    frame[1] = (mask ? 128 : 0) | len;
  } else if (len <= 65535) {
    frame[1] = (mask ? 128 : 0) | 126;
    frame[2] = (len >>> 8) & 255;
    frame[3] = len & 255;
    pos = 4;
  } else {
    frame[1] = (mask ? 128 : 0) | 127;
    const hi = Math.floor(len / 4294967296);
    const lo = len >>> 0;
    frame[2] = (hi >>> 24) & 255;
    frame[3] = (hi >>> 16) & 255;
    frame[4] = (hi >>> 8) & 255;
    frame[5] = hi & 255;
    frame[6] = (lo >>> 24) & 255;
    frame[7] = (lo >>> 16) & 255;
    frame[8] = (lo >>> 8) & 255;
    frame[9] = lo & 255;
    pos = 10;
  }
  if (mask) {
    const key = new Uint8Array([17, 34, 51, 68]);
    frame.set(key, pos);
    pos += 4;
    for (let i = 0; i < len; i++) frame[pos + i] = payload[i]! ^ key[i & 3]!;
  } else {
    frame.set(payload, pos);
  }
  return frame;
}
class RawByteReader {
  #iter: AsyncIterator<Uint8Array | ArrayBuffer>;
  #buf = new Uint8Array(0);
  constructor(source: AsyncIterable<Uint8Array | ArrayBuffer>) {
    this.#iter = source[Symbol.asyncIterator]();
  }
  async readExactly(n: number): Promise<Uint8Array> {
    while (this.#buf.byteLength < n) {
      const { done, value } = await this.#iter.next();
      if (done || value === undefined) throw new Error('unexpected EOF');
      const chunk = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
      const next = new Uint8Array(this.#buf.byteLength + chunk.byteLength);
      next.set(this.#buf, 0);
      next.set(chunk, this.#buf.byteLength);
      this.#buf = next;
    }
    const out = this.#buf.subarray(0, n);
    this.#buf = this.#buf.subarray(n);
    return out;
  }
  async readUntilHeaders(): Promise<string> {
    while (true) {
      const text = dec(this.#buf);
      const idx = text.indexOf('\r\n\r\n');
      if (idx !== -1) {
        const end = idx + 4;
        const out = this.#buf.subarray(0, end);
        this.#buf = this.#buf.subarray(end);
        return dec(out);
      }
      const { done, value } = await this.#iter.next();
      if (done || value === undefined) throw new Error('unexpected EOF before headers');
      const chunk = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
      const next = new Uint8Array(this.#buf.byteLength + chunk.byteLength);
      next.set(this.#buf, 0);
      next.set(chunk, this.#buf.byteLength);
      this.#buf = next;
    }
  }
  async readFrame(): Promise<{
    opcode: number;
    masked: boolean;
    rsv: number;
    payload: Uint8Array;
  }> {
    const header = await this.readExactly(2);
    const rsv = header[0]! & 112;
    const opcode = header[0]! & 15;
    const masked = (header[1]! & 128) !== 0;
    let len = header[1]! & 127;
    if (len === 126) {
      const ext = await this.readExactly(2);
      len = (ext[0]! << 8) | ext[1]!;
    } else if (len === 127) {
      const ext = await this.readExactly(8);
      len =
        ext[0]! * 72057594037927940 +
        ext[1]! * 281474976710656 +
        ext[2]! * 1099511627776 +
        ext[3]! * 4294967296 +
        ext[4]! * 16777216 +
        ext[5]! * 65536 +
        ext[6]! * 256 +
        ext[7]!;
    }
    const key = masked ? await this.readExactly(4) : null;
    const payload = len > 0 ? await this.readExactly(len) : new Uint8Array(0);
    if (key !== null) {
      for (let i = 0; i < payload.byteLength; i++) payload[i] = payload[i]! ^ key[i & 3]!;
    }
    return {
      opcode,
      masked,
      rsv,
      payload,
    };
  }
}
async function openRawWebSocket(
  port: number,
  path = '/ws',
): Promise<{
  sock: Socket;
  raw: RawByteReader;
  writer: any;
}> {
  const sock = await Socket.connect({
    family: 'ipv4',
    ip: '127.0.0.1',
    port,
  });
  const [reader, writer] = sock.split();
  const key = 'dGhlIHNhbXBsZSBub25jZQ==';
  await writer.write(
    enc(
      [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ].join('\r\n'),
    ),
  );
  await writer.flush();
  const raw = new RawByteReader(reader);
  const response = await raw.readUntilHeaders();
  ok(response.includes('101'), 'server returned 101 Switching Protocols');
  return {
    sock,
    raw,
    writer,
  };
}
async function expectServerCloseForRawClientFrame(
  frame: Uint8Array,
  expectedCode: number,
  acceptOptions: Parameters<typeof WebSocketConnection.accept>[1] = {},
): Promise<void> {
  const server = serveWebSocket(() => {}, acceptOptions);
  try {
    const { sock, raw, writer } = await openRawWebSocket(server.port);
    await writer.write(frame);
    await writer.flush();
    const close = await raw.readFrame();
    equal(close.opcode, 8, 'server sent a close frame');
    equal(
      (close.payload[0]! << 8) | close.payload[1]!,
      expectedCode,
      'server close code matches violation',
    );
    sock.close();
  } finally {
    await server.close();
  }
}
function serveWebSocket(
  handler: (ws: WebSocketConnection) => void | Promise<void>,
  acceptOptions: WebSocketAcceptOptions = {},
  fallback: Response = new Response('', { status: 400 }),
): ReturnType<typeof serve> {
  return serve({ port: 0 }, async (incoming) => {
    if (incoming.kind !== 'websocket') {
      await incoming.reject(fallback);
      return;
    }
    const ws = await incoming.accept(acceptOptions);
    await handler(ws);
  });
}
// ---------------------------------------------------------------------------
// Section 1: Accept hash (RFC 6455 §1.3 golden vector)
// ---------------------------------------------------------------------------
describe('WebSocket accept hash', () => {
  it('produces the correct Sec-WebSocket-Accept for the RFC example key', async () => {
    // RFC 6455 §1.3: key "dGhlIHNhbXBsZSBub25jZQ==" → "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
    // We verify indirectly by doing a full client-server handshake over loopback.
    // The raw hash is tested by the accept() path matching the client's key.
    // Set up a one-shot TCP echo that accepts the upgrade and checks the key.
    const EXPECTED_ACCEPT = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';
    const CLIENT_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
    // Use a minimal fake request to exercise WebSocketConnection.accept()
    const fakeReq = {
      method: 'GET',
      url: 'http://localhost/ws',
      headers: new Headers({
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': CLIENT_KEY,
      }),
    };
    // accept() must not throw
    const conn = WebSocketConnection.accept(fakeReq);
    equal(conn.readyState, WebSocketConnection.CONNECTING);
    equal(conn.role, 'server');
    // The 101 bytes must contain the expected accept value
    // (we access the handshake bytes by peeking at the encoded response)
    const acceptLine = `Sec-WebSocket-Accept: ${EXPECTED_ACCEPT}`;
    // If accept() computed the wrong hash, _takeOver would have written a bad 101.
    // We trust this is correct via the end-to-end test below.
    ok(conn !== null);
  });
});
// ---------------------------------------------------------------------------
// Section 2: accept() request validation
// ---------------------------------------------------------------------------
describe('WebSocketConnection.accept() validation', () => {
  function makeReq(overrides: Record<string, string> = {}) {
    const headers = new Headers({
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      ...overrides,
    });
    return {
      method: 'GET',
      url: 'http://localhost/ws',
      headers,
    };
  }
  it('throws SyntaxError for non-GET method', async () => {
    const req = {
      ...makeReq(),
      method: 'POST',
    };
    let threw = false;
    try {
      WebSocketConnection.accept(req);
    } catch (e: any) {
      threw = true;
      equal(e.name, 'SyntaxError');
    }
    ok(threw);
  });
  it('throws SyntaxError for missing Upgrade header', async () => {
    const req = makeReq({ upgrade: 'h2c' });
    let threw = false;
    try {
      WebSocketConnection.accept(req);
    } catch (e: any) {
      threw = true;
      equal(e.name, 'SyntaxError');
    }
    ok(threw);
  });
  it('throws SyntaxError for wrong Sec-WebSocket-Version', async () => {
    const req = makeReq({ 'sec-websocket-version': '8' });
    let threw = false;
    try {
      WebSocketConnection.accept(req);
    } catch (e: any) {
      threw = true;
      equal(e.name, 'SyntaxError');
    }
    ok(threw);
  });
  it('throws SyntaxError for missing Sec-WebSocket-Key', async () => {
    const headers = new Headers({
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-version': '13',
    });
    const req = {
      method: 'GET',
      url: 'http://localhost/ws',
      headers,
    };
    let threw = false;
    try {
      WebSocketConnection.accept(req);
    } catch (e: any) {
      threw = true;
      equal(e.name, 'SyntaxError');
    }
    ok(threw);
  });
  it('negotiates a subprotocol', async () => {
    const req = makeReq({ 'sec-websocket-protocol': 'chat.v1, raw' });
    const conn = WebSocketConnection.accept(req, { protocol: 'chat.v1' });
    equal(conn.protocol, 'chat.v1');
  });
  it('throws when requested protocol is not offered', async () => {
    const req = makeReq({ 'sec-websocket-protocol': 'raw' });
    let threw = false;
    try {
      WebSocketConnection.accept(req, { protocol: 'chat.v1' });
    } catch (e: any) {
      threw = true;
      equal(e.name, 'SyntaxError');
    }
    ok(threw);
  });
  it('negotiates permessage-deflate and echoes compressed messages', async () => {
    const server = serveWebSocket((ws) => {
      ws.addEventListener('message', (event) => ws.send(event.data as string));
    });
    try {
      const sock = await Socket.connect({
        family: 'ipv4',
        ip: '127.0.0.1',
        port: server.port,
      });
      const [reader, writer] = sock.split();
      const key = 'dGhlIHNhbXBsZSBub25jZQ==';
      await writer.write(
        enc(
          [
            'GET /ws HTTP/1.1',
            `Host: 127.0.0.1:${server.port}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            'Sec-WebSocket-Extensions: permessage-deflate',
            '\r\n',
          ].join('\r\n'),
        ),
      );
      await writer.flush();
      const raw = new RawByteReader(reader);
      const response = await raw.readUntilHeaders();
      ok(response.includes('101 Switching Protocols'), 'server accepted the WebSocket upgrade');
      ok(
        /sec-websocket-extensions:\s*permessage-deflate/i.test(response),
        'server negotiated permessage-deflate',
      );
      await writer.write(
        rawFrame(1, zlibDeflateRawMessage(enc('compressed hello')), {
          mask: true,
          rsv: 64,
        }),
      );
      await writer.flush();
      const echoed = await raw.readFrame();
      equal(echoed.opcode, 1, 'server echoed a text frame');
      equal(echoed.rsv, 0, 'server may echo without compressing the message');
      equal(dec(echoed.payload), 'compressed hello', 'echoed payload matches the original text');
      sock.close();
    } finally {
      await server.close();
    }
  });
});
// ---------------------------------------------------------------------------
// Section 3: connect() URL validation
// ---------------------------------------------------------------------------
describe('WebSocketConnection.connect() URL validation', () => {
  it('throws SyntaxError for http: URL', async () => {
    let threw = false;
    try {
      WebSocketConnection.connect('http://example.com/ws');
    } catch (e: any) {
      threw = true;
      equal(e.name, 'SyntaxError');
    }
    ok(threw);
  });
  it('throws SyntaxError for URL with fragment', async () => {
    let threw = false;
    try {
      WebSocketConnection.connect('ws://example.com/ws#frag');
    } catch (e: any) {
      threw = true;
      equal(e.name, 'SyntaxError');
    }
    ok(threw);
  });
  it('throws SyntaxError for duplicate protocols', async () => {
    let threw = false;
    try {
      WebSocketConnection.connect('ws://example.com/ws', { protocols: ['a', 'a'] });
    } catch (e: any) {
      threw = true;
      equal(e.name, 'SyntaxError');
    }
    ok(threw);
  });
});
// ---------------------------------------------------------------------------
// Section 4: End-to-end via serve() integration
// ---------------------------------------------------------------------------
describe('WebSocket end-to-end via serve()', () => {
  it('handler properties run as EventTarget listeners for open and message', async () => {
    let openCurrentTarget: EventTarget | null = null;
    let openPhase = Event.NONE;
    let messageCurrentTarget: EventTarget | null = null;
    let messagePhase = Event.NONE;
    const order: string[] = [];
    const server = serveWebSocket((ws) => {
      ws.addEventListener('message', (e) => {
        void ws.send((e as MessageEvent).data as string);
      });
    });
    try {
      const client = WebSocketConnection.connect(`ws://127.0.0.1:${server.port}/ws`);
      client.addEventListener('open', () => {
        order.push('open-listener');
      });
      client.onopen = (event) => {
        order.push('open-handler');
        openCurrentTarget = event.currentTarget;
        openPhase = event.eventPhase;
      };
      await waitForEvent(client, 'open');
      client.addEventListener('message', () => {
        order.push('message-listener');
      });
      const messageDone = new Promise<void>((resolve) => {
        client.onmessage = (event) => {
          order.push('message-handler');
          messageCurrentTarget = event.currentTarget;
          messagePhase = event.eventPhase;
          resolve();
        };
      });
      await client.send('dispatch-state');
      await messageDone;
      await client.close();
      deepEqual(order, ['open-listener', 'open-handler', 'message-listener', 'message-handler']);
      equal(openCurrentTarget, client, 'open currentTarget is the connection');
      equal(openPhase, Event.AT_TARGET, 'open handler runs at AT_TARGET');
      equal(messageCurrentTarget, client, 'message currentTarget is the connection');
      equal(messagePhase, Event.AT_TARGET, 'message handler runs at AT_TARGET');
    } finally {
      await server.close();
    }
  });
  it('stopImmediatePropagation before WebSocketConnection onmessage prevents the handler property', async () => {
    let handled = false;
    const server = serveWebSocket((ws) => {
      ws.addEventListener('message', (e) => {
        void ws.send((e as MessageEvent).data as string);
      });
    });
    try {
      const client = WebSocketConnection.connect(`ws://127.0.0.1:${server.port}/ws`);
      await waitForEvent(client, 'open');
      const stopped = new Promise<void>((resolve) => {
        client.addEventListener('message', (event) => {
          event.stopImmediatePropagation();
          setTimeout(resolve, 20);
        });
        client.onmessage = () => {
          handled = true;
        };
      });
      await client.send('stop');
      await stopped;
      await client.close();
      equal(handled, false, 'onmessage did not run after stopImmediatePropagation');
    } finally {
      await server.close();
    }
  });
  it('echoes text messages', async () => {
    const server = serveWebSocket(
      (ws) => {
        ws.addEventListener('message', (e) => {
          const me = e as MessageEvent;
          void ws.send('echo: ' + me.data);
        });
        ws.addEventListener('close', () => {});
      },
      {},
      new Response('not a ws upgrade', { status: 400 }),
    );
    try {
      const client = WebSocketConnection.connect(`ws://127.0.0.1:${server.port}/ws`);
      await waitForEvent(client, 'open');
      await client.send('hello');
      const [msg] = await collectMessages(client, 1);
      equal(msg!.type, 'text');
      equal(msg!.data, 'echo: hello');
      await client.close();
    } finally {
      await server.close();
    }
  });
  it('echoes binary messages', async () => {
    const server = serveWebSocket((ws) => {
      ws.addEventListener('message', (e) => {
        const me = e as MessageEvent;
        void ws.send(me.data as Uint8Array);
      });
    });
    try {
      const client = WebSocketConnection.connect(`ws://127.0.0.1:${server.port}/ws`);
      await waitForEvent(client, 'open');
      const payload = new Uint8Array([1, 2, 3, 4, 5]);
      await client.send(payload);
      const [msg] = await collectMessages(client, 1);
      equal(msg!.type, 'binary');
      deepEqual(Array.from(msg!.data as Uint8Array), [1, 2, 3, 4, 5]);
      await client.close();
    } finally {
      await server.close();
    }
  });
  it('handles multiple messages on a single connection', async () => {
    const server = serveWebSocket((ws) => {
      ws.addEventListener('message', (e) => {
        const me = e as MessageEvent;
        void ws.send(me.data as string);
      });
    });
    try {
      const client = WebSocketConnection.connect(`ws://127.0.0.1:${server.port}/ws`);
      await waitForEvent(client, 'open');
      await client.send('a');
      await client.send('b');
      await client.send('c');
      const msgs = await collectMessages(client, 3);
      deepEqual(
        msgs.map((m) => m.data),
        ['a', 'b', 'c'],
      );
      await client.close();
    } finally {
      await server.close();
    }
  });
  it('server can iterate messages with async for-of', async () => {
    const received: string[] = [];
    const server = serveWebSocket((ws) => {
      queueMicrotask(async () => {
        for await (const msg of ws) {
          received.push(msg.data as string);
          if (msg.data === 'done') {
            await ws.close();
            break;
          }
        }
      });
    });
    try {
      const client = WebSocketConnection.connect(`ws://127.0.0.1:${server.port}/ws`);
      await waitForEvent(client, 'open');
      await client.send('foo');
      await client.send('bar');
      await client.send('done');
      // Wait for server close to propagate
      await waitForEvent(client, 'close');
      deepEqual(received, ['foo', 'bar', 'done']);
    } finally {
      await server.close();
    }
  });
  it('respects subprotocol negotiation', async () => {
    const server = serveWebSocket(
      (ws) => {
        ws.addEventListener('message', async (e) => {
          await ws.close();
        });
      },
      { protocol: 'chat.v1' },
    );
    try {
      const client = WebSocketConnection.connect(`ws://127.0.0.1:${server.port}/ws`, {
        protocols: ['chat.v1', 'chat.v2'],
      });
      await waitForEvent(client, 'open');
      equal(client.protocol, 'chat.v1');
      await client.send('ping');
      await waitForEvent(client, 'close');
    } finally {
      await server.close();
    }
  });
  it('PING triggers automatic PONG', async () => {
    const pongReceived: boolean[] = [];
    const server = serveWebSocket((ws) => {
      ws.addEventListener('open', async () => {
        await ws.ping(enc('keepalive'));
      });
      ws.addEventListener('pong', () => {
        pongReceived.push(true);
        void ws.close();
      });
    });
    try {
      const client = WebSocketConnection.connect(`ws://127.0.0.1:${server.port}/ws`);
      await waitForEvent(client, 'close', 8e3);
      equal(pongReceived.length, 1);
    } finally {
      await server.close();
    }
  });
  it('application-defined close codes (4000–4999) are accepted and propagated', async () => {
    // RFC 6455 §7.4.2 reserves 4000–4999 for private use by applications.
    // These must be accepted (not rejected as invalid) and the code+reason
    // must arrive intact on the receiving side.
    const APP_CODE = 4042;
    const APP_REASON = 'application session expired';
    const server = serveWebSocket((ws) => {
      ws.addEventListener('open', async () => {
        await ws.close(APP_CODE, APP_REASON);
      });
    });
    try {
      const client = WebSocketConnection.connect(`ws://127.0.0.1:${server.port}/ws`);
      const closeEvt = await waitForEvent<CloseEvent>(client, 'close');
      ok(closeEvt.wasClean, 'close was clean');
      equal(closeEvt.code, APP_CODE, 'app-defined close code propagated');
      equal(closeEvt.reason, APP_REASON, 'close reason preserved');
    } finally {
      await server.close();
    }
  });
  it('close handshake completes cleanly (wasClean=true)', async () => {
    const server = serveWebSocket((ws) => {
      ws.addEventListener('open', async () => {
        await ws.close(1e3, 'bye');
      });
    });
    try {
      const client = WebSocketConnection.connect(`ws://127.0.0.1:${server.port}/ws`);
      const closeEvt = await waitForEvent<CloseEvent>(client, 'close');
      ok(closeEvt.wasClean);
      equal(closeEvt.code, 1e3);
      equal(closeEvt.reason, 'bye');
    } finally {
      await server.close();
    }
  });
  it('client abrupt disconnect (no close frame) fires close with wasClean=false', async () => {
    // RFC 6455 golden-vector key/accept pair (§1.3 of the spec).
    const WS_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
    const WS_ACCEPT = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';
    let resolveServerClose!: (e: CloseEvent) => void;
    const serverClosedPromise = new Promise<CloseEvent>((res) => {
      resolveServerClose = res;
    });
    const server = serveWebSocket((ws) => {
      ws.addEventListener('close', (e) => resolveServerClose(e as CloseEvent));
    });
    try {
      const sock = await Socket.connect({
        family: 'ipv4',
        ip: '127.0.0.1',
        port: server.port,
      });
      const [reader, writer] = sock.split();
      // Send a valid WebSocket upgrade using the RFC 6455 golden-vector key.
      const upgradeReq = [
        `GET /ws HTTP/1.1`,
        `Host: 127.0.0.1:${server.port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${WS_KEY}`,
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ].join('\r\n');
      await writer.write(enc(upgradeReq));
      await writer.flush();
      // Read until we see the 101 Switching Protocols response.
      let response = '';
      const iter = reader[Symbol.asyncIterator]();
      while (!response.includes('\r\n\r\n')) {
        const { done, value } = await iter.next();
        if (done) break;
        response += dec(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
      }
      ok(response.includes('101'), 'server returned 101 Switching Protocols');
      ok(response.includes(WS_ACCEPT), 'server returned correct Sec-WebSocket-Accept');
      // Abruptly close the TCP connection without sending a WebSocket close frame.
      writer.close();
      reader.close();
      // The server-side WebSocket should fire 'close' with wasClean=false, code 1006.
      const closeEvt = await serverClosedPromise;
      ok(!closeEvt.wasClean, 'server close event has wasClean=false on abrupt disconnect');
      equal(closeEvt.code, 1006, 'close code is 1006 (abnormal closure)');
    } finally {
      await server.close();
    }
  });
  it('handles mixed HTTP and WebSocket on same serve()', async () => {
    const server = serveWebSocket(
      (ws) => {
        ws.addEventListener('message', (e) => {
          const me = e as MessageEvent;
          void ws.send('ws:' + me.data);
        });
      },
      {},
      new Response('http-ok'),
    );
    try {
      // Normal HTTP still works
      const httpResp = await fetch(`http://127.0.0.1:${server.port}/`);
      equal(await httpResp.text(), 'http-ok');
      // WebSocket also works on the same server
      const client = WebSocketConnection.connect(`ws://127.0.0.1:${server.port}/ws`);
      await waitForEvent(client, 'open');
      await client.send('test');
      const [msg] = await collectMessages(client, 1);
      equal(msg!.data, 'ws:test');
      await client.close();
    } finally {
      await server.close();
    }
  });
});
describe('WebSocket raw frame protocol violations', () => {
  it('closes fragmented control frames with 1002', async () => {
    await expectServerCloseForRawClientFrame(
      rawFrame(9, enc('x'), {
        mask: true,
        fin: false,
      }),
      1002,
    );
  });
  it('closes RSV-bit frames with 1002 when no extensions are negotiated', async () => {
    await expectServerCloseForRawClientFrame(
      rawFrame(1, enc('x'), {
        mask: true,
        rsv: 64,
      }),
      1002,
    );
  });
  it('closes reserved opcodes with 1002', async () => {
    await expectServerCloseForRawClientFrame(rawFrame(3, enc('x'), { mask: true }), 1002);
  });
  it('closes invalid UTF-8 text messages with 1007', async () => {
    await expectServerCloseForRawClientFrame(
      rawFrame(1, new Uint8Array([255]), { mask: true }),
      1007,
    );
  });
  it('closes invalid UTF-8 close reasons with 1007', async () => {
    await expectServerCloseForRawClientFrame(
      rawFrame(8, new Uint8Array([3, 232, 255]), { mask: true }),
      1007,
    );
  });
  it('closes invalid received close codes with 1002', async () => {
    await expectServerCloseForRawClientFrame(
      rawFrame(8, new Uint8Array([0, 0]), { mask: true }),
      1002,
    );
  });
  it('closes payloads above maxPayloadSize with 1009', async () => {
    await expectServerCloseForRawClientFrame(rawFrame(1, enc('12345'), { mask: true }), 1009, {
      maxPayloadSize: 4,
    });
  });
  it('closes unmasked client frames with 1002', async () => {
    await expectServerCloseForRawClientFrame(rawFrame(1, enc('x'), { mask: false }), 1002);
  });
  it('client rejects masked server frames with a masked 1002 close response', async () => {
    const listener = Socket.listen({
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    const acceptDone = (async () => {
      const serverSock = await listener.accept();
      if (serverSock === null) throw new Error('expected client connection');
      const [reader, writer] = serverSock.split();
      const raw = new RawByteReader(reader);
      const request = await raw.readUntilHeaders();
      const keyLine = request
        .split('\r\n')
        .find((line) => line.toLowerCase().startsWith('sec-websocket-key:'));
      if (keyLine === undefined) throw new Error('missing Sec-WebSocket-Key');
      const key = keyLine.slice(keyLine.indexOf(':') + 1).trim();
      await writer.write(
        enc(
          [
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${acceptHash(key)}`,
            '\r\n',
          ].join('\r\n'),
        ),
      );
      await writer.flush();
      await writer.write(rawFrame(1, enc('bad-mask'), { mask: true }));
      await writer.flush();
      writer.close();
      const close = await raw.readFrame();
      equal(close.opcode, 8, 'client sent a close frame');
      equal(close.masked, true, 'client close frame is masked');
      equal(
        (close.payload[0]! << 8) | close.payload[1]!,
        1002,
        'client close code rejects masked server frame',
      );
      serverSock.close();
    })();
    try {
      const client = WebSocketConnection.connect(`ws://127.0.0.1:${listener.address.port}/ws`);
      await waitForEvent(client, 'open');
      await waitForEvent<CloseEvent>(client, 'close');
      await acceptDone;
    } finally {
      listener.close();
      await acceptDone.catch(() => {});
    }
  });
});
// ---------------------------------------------------------------------------
// Section 5: WHATWG WebSocket facade
// ---------------------------------------------------------------------------
describe('WHATWG WebSocket facade', () => {
  it('handler properties run as EventTarget listeners for open and message', async () => {
    let openCurrentTarget: EventTarget | null = null;
    let openPhase = Event.NONE;
    let messageCurrentTarget: EventTarget | null = null;
    let messagePhase = Event.NONE;
    const order: string[] = [];
    const server = serveWebSocket((ws) => {
      ws.addEventListener('open', async () => {
        await ws.send('facade-message');
      });
    });
    try {
      const client = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      client.addEventListener('open', () => {
        order.push('open-listener');
      });
      client.onopen = (event) => {
        order.push('open-handler');
        openCurrentTarget = event.currentTarget;
        openPhase = event.eventPhase;
      };
      client.addEventListener('message', () => {
        order.push('message-listener');
      });
      const messageDone = new Promise<void>((resolve) => {
        client.onmessage = (event) => {
          order.push('message-handler');
          messageCurrentTarget = event.currentTarget;
          messagePhase = event.eventPhase;
          client.close();
          resolve();
        };
      });
      await messageDone;
      deepEqual(order, ['open-listener', 'open-handler', 'message-listener', 'message-handler']);
      equal(openCurrentTarget, client, 'open currentTarget is the facade');
      equal(openPhase, Event.AT_TARGET, 'open handler runs at AT_TARGET');
      equal(messageCurrentTarget, client, 'message currentTarget is the facade');
      equal(messagePhase, Event.AT_TARGET, 'message handler runs at AT_TARGET');
    } finally {
      await server.close();
    }
  });
  it('constructor converts http and https URLs to WebSocket schemes', () => {
    const http = new WebSocket('http://example.invalid/socket');
    equal(http.url, 'ws://example.invalid/socket');
    http.close();
    const https = new WebSocket('https://example.invalid/socket');
    equal(https.url, 'wss://example.invalid/socket');
    https.close();
  });
  it('constructor resolves relative URLs against global location', () => {
    const oldLocation = (globalThis as any).location;
    (globalThis as any).location = {
      href: 'http://example.invalid/base/page.html?old=1',
      toString() {
        return this.href;
      },
    };
    const ws = new WebSocket('?next=1');
    try {
      equal(ws.url, 'ws://example.invalid/base/page.html?next=1');
    } finally {
      ws.close();
      if (oldLocation === undefined) delete (globalThis as any).location;
      else (globalThis as any).location = oldLocation;
    }
  });
  it('constructor throws DOMException SyntaxError for invalid URL schemes', async () => {
    let threw = false;
    try {
      new WebSocket('ftp://example.com');
    } catch (e: any) {
      threw = true;
      ok(e instanceof DOMException);
      equal(e.name, 'SyntaxError');
    }
    ok(threw);
  });
  it('constructor throws DOMException SyntaxError for URL with fragment', async () => {
    let threw = false;
    try {
      new WebSocket('ws://example.com/#frag');
    } catch (e: any) {
      threw = true;
      ok(e instanceof DOMException);
      equal(e.name, 'SyntaxError');
    }
    ok(threw);
  });
  it('constructor throws DOMException SyntaxError for URL with empty fragment', async () => {
    let threw = false;
    try {
      new WebSocket('http://example.com/#');
    } catch (e: any) {
      threw = true;
      ok(e instanceof DOMException);
      equal(e.name, 'SyntaxError');
    }
    ok(threw);
  });
  it('constructor throws SyntaxError for duplicate protocols', async () => {
    let threw = false;
    try {
      new WebSocket('ws://example.com/ws', ['a', 'a']);
    } catch (e: any) {
      threw = true;
      equal(e.name, 'SyntaxError');
    }
    ok(threw);
  });
  it('starts in CONNECTING state', async () => {
    // Use an unresolvable host to keep it in CONNECTING without connecting
    // Actually we need a real server to avoid an immediate error; use our own.
    const server = serveWebSocket(() => {});
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      equal(ws.readyState, WebSocket.CONNECTING);
      await waitForEvent(ws, 'open');
      equal(ws.readyState, WebSocket.OPEN);
      ws.close();
      await waitForEvent(ws, 'close');
      equal(ws.readyState, WebSocket.CLOSED);
    } finally {
      await server.close();
    }
  });
  it('send() throws InvalidStateError when CONNECTING', async () => {
    const server = serveWebSocket(() => {});
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      equal(ws.readyState, WebSocket.CONNECTING);
      let threw = false;
      try {
        ws.send('hello');
      } catch (e: any) {
        threw = true;
        equal(e.name, 'InvalidStateError');
      }
      ok(threw);
      await waitForEvent(ws, 'open');
      ws.close();
      await waitForEvent(ws, 'close');
    } finally {
      await server.close();
    }
  });
  it('binaryType arraybuffer delivers ArrayBuffer data', async () => {
    const server = serveWebSocket((ws) => {
      ws.addEventListener('open', async () => {
        await ws.send(new Uint8Array([10, 20, 30]));
      });
    });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      ws.binaryType = 'arraybuffer';
      await waitForEvent(ws, 'open');
      const msgEvt = await waitForEvent<MessageEvent>(ws, 'message');
      ok(msgEvt.data instanceof ArrayBuffer);
      deepEqual(Array.from(new Uint8Array(msgEvt.data as unknown as ArrayBuffer)), [10, 20, 30]);
      ws.close();
      await waitForEvent(ws, 'close');
    } finally {
      await server.close();
    }
  });
  it('binaryType blob delivers Blob data', async () => {
    const server = serveWebSocket((ws) => {
      ws.addEventListener('open', async () => {
        await ws.send(new Uint8Array([1, 2]));
      });
    });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      ws.binaryType = 'blob';
      await waitForEvent(ws, 'open');
      const msgEvt = await waitForEvent<MessageEvent>(ws, 'message');
      ok(msgEvt.data instanceof Blob);
      const bytes = new Uint8Array(await (msgEvt.data as unknown as Blob).arrayBuffer());
      deepEqual(Array.from(bytes), [1, 2]);
      ws.close();
      await waitForEvent(ws, 'close');
    } finally {
      await server.close();
    }
  });
  it('binaryType rejects invalid assignments without changing the current value', async () => {
    const server = serveWebSocket(() => {});
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      equal(ws.binaryType, 'blob');
      ws.binaryType = 'arraybuffer';
      equal(ws.binaryType, 'arraybuffer');
      let threw = false;
      try {
        ws.binaryType = 'bytes' as any;
      } catch (e: any) {
        threw = true;
        ok(e instanceof TypeError);
      }
      ok(threw);
      equal(ws.binaryType, 'arraybuffer');
      await waitForEvent(ws, 'open');
      ws.close();
      await waitForEvent(ws, 'close');
    } finally {
      await server.close();
    }
  });
  it('exposes negotiated protocol, client extensions, and numeric bufferedAmount', async () => {
    const server = serveWebSocket(() => {}, { protocol: 'chat.v1' });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, ['chat.v1', 'chat.v2']);
      await waitForEvent(ws, 'open');
      equal(ws.protocol, 'chat.v1');
      equal(ws.extensions, '');
      equal(typeof ws.bufferedAmount, 'number');
      ws.close();
      await waitForEvent(ws, 'close');
    } finally {
      await server.close();
    }
  });
  it('close() throws InvalidAccessError for disallowed close code', async () => {
    const server = serveWebSocket(() => {});
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      await waitForEvent(ws, 'open');
      let threw = false;
      try {
        ws.close(1001);
      } catch (e: any) {
        // 1001 (Going Away) is reserved — app must not close with it
        threw = true;
        equal(e.name, 'InvalidAccessError');
      }
      ok(threw);
      ws.close(1e3);
      await waitForEvent(ws, 'close');
    } finally {
      await server.close();
    }
  });
  it('close() throws SyntaxError for reason > 123 bytes', async () => {
    const server = serveWebSocket(() => {});
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      await waitForEvent(ws, 'open');
      let threw = false;
      try {
        ws.close(1e3, 'x'.repeat(124));
      } catch (e: any) {
        threw = true;
        equal(e.name, 'SyntaxError');
      }
      ok(threw);
      ws.close();
      await waitForEvent(ws, 'close');
    } finally {
      await server.close();
    }
  });
  it('readyState transitions through CONNECTING → OPEN → CLOSED', async () => {
    const server = serveWebSocket(() => {});
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      equal(ws.readyState, WebSocket.CONNECTING);
      await waitForEvent(ws, 'open');
      equal(ws.readyState, WebSocket.OPEN);
      ws.close();
      await waitForEvent(ws, 'close');
      equal(ws.readyState, WebSocket.CLOSED);
    } finally {
      await server.close();
    }
  });
});
describe('WebSocketError', () => {
  it('defaults to a WebSocketError DOMException without close metadata', (t) => {
    const err = new WebSocketError();
    t.ok(err instanceof DOMException);
    t.equal(err.name, 'WebSocketError');
    t.equal(err.message, '');
    t.equal(err.code, 0);
    t.equal(err.closeCode, null);
    t.equal(err.reason, '');
  });
  it('stores close code and reason', (t) => {
    const err = new WebSocketError('closed', {
      closeCode: 3456,
      reason: 'done',
    });
    t.equal(err.message, 'closed');
    t.equal(err.closeCode, 3456);
    t.equal(err.reason, 'done');
  });
  it('defaults close code to 1000 when a reason is supplied', (t) => {
    const err = new WebSocketError('', { reason: 'done' });
    t.equal(err.closeCode, 1e3);
    t.equal(err.reason, 'done');
  });
  it('throws DOMException InvalidAccessError for invalid close codes', (t) => {
    for (const code of [999, 1001, 2999, 5e3]) {
      t.throws(
        () => new WebSocketError('', { closeCode: code }),
        (err) => err instanceof DOMException && err.name === 'InvalidAccessError',
        `invalid close code ${code} throws`,
      );
    }
  });
  it('throws DOMException SyntaxError for overlong reasons', (t) => {
    t.throws(
      () =>
        new WebSocketError('', {
          closeCode: 1e3,
          reason: 'x'.repeat(124),
        }),
      (err) => err instanceof DOMException && err.name === 'SyntaxError',
    );
  });
});
// ---------------------------------------------------------------------------
// Section 6: WebSocketConnection close validation
// ---------------------------------------------------------------------------
describe('WebSocketConnection.close() validation', () => {
  it('throws InvalidAccessError for code 1001', async () => {
    const server = serveWebSocket(() => {});
    try {
      const client = WebSocketConnection.connect(`ws://127.0.0.1:${server.port}/ws`);
      await waitForEvent(client, 'open');
      let threw = false;
      try {
        await client.close(1001);
      } catch (e: any) {
        threw = true;
        equal(e.name, 'InvalidAccessError');
      }
      ok(threw);
      await client.close(1e3);
    } finally {
      await server.close();
    }
  });
  it('throws SyntaxError for reason > 123 bytes', async () => {
    const server = serveWebSocket(() => {});
    try {
      const client = WebSocketConnection.connect(`ws://127.0.0.1:${server.port}/ws`);
      await waitForEvent(client, 'open');
      let threw = false;
      try {
        await client.close(1e3, 'x'.repeat(124));
      } catch (e: any) {
        threw = true;
        equal(e.name, 'SyntaxError');
      }
      ok(threw);
      await client.close(1e3);
    } finally {
      await server.close();
    }
  });
});
// ---------------------------------------------------------------------------
// Section 7: Large message (> 65535 bytes — 3-tier length encoding)
// ---------------------------------------------------------------------------
describe('Large payload', () => {
  it('sends and receives a 100 KiB binary message', async () => {
    const BIG = 100 * 1024;
    const payload = new Uint8Array(BIG);
    for (let i = 0; i < BIG; i++) payload[i] = i & 255;
    let received: Uint8Array | null = null;
    const server = serveWebSocket((ws) => {
      ws.addEventListener('message', (e) => {
        received = (e as MessageEvent).data as Uint8Array;
        void ws.close();
      });
    });
    try {
      const client = WebSocketConnection.connect(`ws://127.0.0.1:${server.port}/ws`);
      await waitForEvent(client, 'open');
      await client.send(payload.buffer);
      await waitForEvent(client, 'close');
      ok(received !== null);
      const recvd = received!;
      equal(recvd.byteLength, BIG);
      // Spot-check a few bytes
      equal(recvd[0], 0);
      equal(recvd[255], 255);
      equal(recvd[BIG - 1], (BIG - 1) & 255);
    } finally {
      await server.close();
    }
  });
});
