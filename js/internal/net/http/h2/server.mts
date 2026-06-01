/**
 * internal:net/http/h2/server — H2ServerDriver.
 *
 * ## Stream lifecycle (server side)
 *
 * 1. onBeginHeaders(streamId, isTrailers=false) — allocate H2ServerStream.
 * 2. onHeader — accumulate `:method`, `:path`, `:scheme`, `:authority` + headers.
 * 3. onFrameRecv(HEADERS, END_HEADERS) — initial headers complete.
 *    If END_STREAM also set → no body, trigger dispatch.
 * 4. onDataChunk(bytes) — push bytes to body queue.
 * 5. onFrameRecv(DATA, END_STREAM) — body complete, trigger dispatch.
 * 6. Handler completes → submit HEADERS response + DATA frame(s).
 *
 * ## h2c Upgrade (runFromUpgrade)
 *
 * When a connection was upgraded from HTTP/1.1 via the `Upgrade: h2c` dance,
 * `runFromUpgrade` is called instead of `run`. It calls `session.upgradeFromH1`
 * to tell nghttp2 about the prior-knowledge state, then dispatches the original
 * HTTP/1.1 request as stream 1 without going through the normal header-parsing
 * callbacks (those callbacks only fire for frames received from the wire after
 * the upgrade).
 *
 * ## RST_STREAM / stream cancellation
 *
 * When the client sends RST_STREAM, `onStreamClose` fires with a non-zero
 * errorCode. If `dispatchStream` is still waiting for the request body
 * (triggerDispatch not yet called), it unblocks immediately and returns without
 * sending a response. If the response-submission phase has already started,
 * any nghttp2 error from submitting on a closed stream is caught silently.
 *
 * ## Concurrency safety
 *
 * `startDispatch` wraps dispatchStream errors so `Promise.all(inFlight)` in
 * the finally block never rejects. All drainWrite calls are serialized via the
 * drainChain promise-mutex — concurrent session_mem_send2 calls on the same
 * nghttp2_session* would be a data race.
 *
 * @internal
 */

import type { BufferedBytesReader } from '../../../stream.mts';
import type { BytesWriter } from '../../../stream.mts';
import type { ServerDriver, ServerHandler, ServerDriverOptions } from '../../../../net/http/driver.mts';
import { isConnectionTakeover } from '../../../../net/http/driver.mts';
import { Request, Response, Headers } from '../../../../net/http/index.mts';
import { Scanner } from '../../../../parsing/scanner.mts';
import {
  NGHTTP2_FLAG_END_STREAM,
  NGHTTP2_FLAG_END_HEADERS,
  NGHTTP2_FRAME_TYPE_HEADERS,
  NGHTTP2_FRAME_TYPE_DATA,
  NGHTTP2_FRAME_TYPE_GOAWAY,
  NGHTTP2_INTERNAL_ERROR,
  NGHTTP2_PROTOCOL_ERROR,
  NGHTTP2_REFUSED_STREAM,
  NGHTTP2_STREAM_CLOSED,
  NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS,
  NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE,
} from './bindings.mts';
import { Nghttp2Session } from './session.mts';
import type { H2StreamCallbacks } from './session.mts';

// ---------------------------------------------------------------------------
// Per-stream state
// ---------------------------------------------------------------------------

interface H2ServerStream {
  streamId: number;
  method: string;
  path: string;
  scheme: string;
  authority: string;
  headers: Headers;
  trailerHeaders: Headers;
  inTrailers: boolean;
  bodyChunks: Uint8Array[];
  bodyDone: boolean;
  // Set to true when client RST_STREAMs the stream. dispatchStream checks
  // this after triggerDispatch resolves and returns early if true.
  cancelled: boolean;
  triggerDispatch: (() => void) | null;
  // Header validation state (RFC 7540 §8.1.2). Non-null = error code to RST with.
  seenPseudos: Set<string>;
  seenRegularHeader: boolean;
  headerError: number | null;
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function readH2StrictUnsigned(scanner: Scanner, name: string): number {
  const digits = scanner.eatWhile(isDigit);
  if (digits === '') throw new Error(`invalid ${name}`);
  if (!Number.isSafeInteger(Number(digits))) throw new Error(`invalid ${name}`);
  return Number(digits);
}

export function _parseH2StatusHeader(value: string): number {
  const scanner = new Scanner(value, { encoding: 'ascii', format: 'http2' });
  const digits = scanner.eatWhile(isDigit);
  if (digits.length !== 3 || !scanner.done) throw new Error('invalid :status header');
  const status = Number(digits);
  if (status < 100 || status > 999) throw new Error('invalid :status header');
  return status;
}

export function _parseH2ContentLength(value: string): number {
  const scanner = new Scanner(value, { encoding: 'ascii', format: 'http2' });
  let expected: number | null = null;
  while (!scanner.done) {
    scanner.skipSpaceTab();
    const current = readH2StrictUnsigned(scanner, 'content-length');
    scanner.skipSpaceTab();
    if (expected === null) expected = current;
    else if (expected !== current) throw new Error('conflicting content-length headers');
    if (scanner.done) break;
    scanner.expect(',', 'invalid content-length header');
  }
  if (expected === null) throw new Error('invalid content-length header');
  return expected;
}

// Returns true if the string contains any ASCII uppercase letter (A-Z).
function _hasUppercase(s: string): boolean {
  const scanner = new Scanner(s, { encoding: 'ascii', format: 'http2' });
  scanner.eatUntil((code) => code >= 0x41 && code <= 0x5A);
  return !scanner.done;
}

// Connection-specific header fields forbidden in HTTP/2 (RFC 7540 §8.1.2.2).
const _FORBIDDEN_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);

// ---------------------------------------------------------------------------
// Shared context setup (used by both run() and runFromUpgrade())
// ---------------------------------------------------------------------------

interface H2ServerCtx {
  streams: Map<number, H2ServerStream>;
  inFlight: Set<Promise<void>>;
  drainWrite: () => Promise<void>;
  drainStreams: () => void;
  startDispatch: (stream: H2ServerStream) => void;
  goawayReceived: () => boolean;
  callbacks: H2StreamCallbacks;
  setSession: (s: Nghttp2Session) => void;
}

function _makeCtx(writer: BytesWriter, handler: ServerHandler, maxConcurrent: number): H2ServerCtx {
  const streams = new Map<number, H2ServerStream>();
  const inFlight = new Set<Promise<void>>();
  let drainChain: Promise<void> = Promise.resolve();
  let receivedGoaway = false;
  // Set by setSession() before any closure runs.
  let session = null as unknown as Nghttp2Session;

  function drainWrite(): Promise<void> {
    drainChain = drainChain.then(async () => {
      while (session.wantWrite()) {
        const bytes = await session.flush();
        if (bytes && bytes.byteLength > 0) {
          await writer.write(bytes);
        } else {
          // flow-control window exhausted: nghttp2 wants to write but can't.
          // Break so _recvLoop can process the next incoming WINDOW_UPDATE.
          break;
        }
      }
      await writer.flush();
    });
    return drainChain;
  }

  async function dispatchStream(stream: H2ServerStream): Promise<void> {
    const { streamId } = stream;

    // Wait until the request body is fully received.
    if (!stream.bodyDone) {
      await new Promise<void>((resolve) => { stream.triggerDispatch = resolve; });
    }

    // Client cancelled the stream (RST_STREAM received) while we were waiting.
    if (stream.cancelled) return;

    const totalBodySize = stream.bodyChunks.reduce((n, c) => n + c.byteLength, 0);
    let reqBody: BodyInit | null = null;
    if (totalBodySize > 0) {
      const all = new Uint8Array(totalBodySize);
      let off = 0;
      for (const c of stream.bodyChunks) { all.set(c, off); off += c.byteLength; }
      reqBody = all.buffer;
    }

    // Validate content-length against actual body size (RFC 7540 §8.1.2.6).
    const clHeader = stream.headers.get('content-length');
    if (clHeader !== null) {
      let clValue = -1;
      try { clValue = _parseH2ContentLength(clHeader); }
      catch {
        try { session.submitRstStream(streamId, NGHTTP2_PROTOCOL_ERROR); } catch {}
        await drainWrite();
        return;
      }
      if (clValue !== totalBodySize) {
        try { session.submitRstStream(streamId, NGHTTP2_PROTOCOL_ERROR); } catch {}
        await drainWrite();
        return;
      }
    }

    const url = `${stream.scheme}://${stream.authority}${stream.path}`;
    const req = new Request(url, {
      method: stream.method,
      headers: stream.headers,
      body: reqBody as any,
      trailers: stream.trailerHeaders,
    });

    let res: Response;
    try {
      const result = await handler(req);
      // Check again: RST_STREAM may have arrived while the handler was running.
      if (stream.cancelled) return;
      if (result instanceof Response) {
        res = result;
      } else if (isConnectionTakeover(result) && !result.compatibleProtocols.has('h2')) {
        try { session.submitRstStream(streamId, NGHTTP2_INTERNAL_ERROR); } catch {}
        await drainWrite();
        return;
      } else {
        res = new Response('Internal Server Error', { status: 500 });
      }
    } catch {
      res = new Response('Internal Server Error', { status: 500 });
    }

    // Build and submit the response. If the stream was RST_STREAMed while the
    // handler was running, submitResponse will throw — catch and discard.
    const responseHeaders: Array<[string, string]> = [[':status', String(res.status)]];
    for (const [k, v] of res.headers.entries()) {
      if (k === 'transfer-encoding' || k === 'connection' || k === 'keep-alive') continue;
      responseHeaders.push([k, v]);
    }

    let bodyBytes: Uint8Array | null = null;
    if (res.body) {
      try {
        const buf = await res.arrayBuffer();
        bodyBytes = buf.byteLength > 0 ? new Uint8Array(buf) : null;
      } catch { bodyBytes = null; }
    }

    try {
      const hasTrailers = res._hasOutTrailers();
      const hasBody = bodyBytes !== null || hasTrailers;
      session.submitResponse(streamId, responseHeaders, hasBody);
      await drainWrite();

      if (bodyBytes) {
        session.setStreamData(streamId, bodyBytes);
        await drainWrite();
      }

      if (hasTrailers) {
        let trailersOut: Headers;
        const raw = res._getRawOutTrailers();
        if (raw instanceof Headers) {
          trailersOut = raw;
        } else if (typeof raw === 'function') {
          try { trailersOut = await (raw as () => Headers | Promise<Headers>)(); }
          catch { trailersOut = new Headers(); }
        } else {
          trailersOut = new Headers();
        }
        const trailerList: Array<[string, string]> = [];
        for (const [k, v] of trailersOut.entries()) trailerList.push([k, v]);
        if (trailerList.length > 0) {
          session.setStreamData(streamId, null);
          await drainWrite();
          session.submitTrailer(streamId, trailerList);
          await drainWrite();
        } else {
          session.setStreamData(streamId, null);
          await drainWrite();
        }
      } else if (hasBody) {
        session.setStreamData(streamId, null);
        await drainWrite();
      }
    } catch {
      // Stream was reset by client (RST_STREAM) while we were responding.
    }
  }

  function startDispatch(stream: H2ServerStream): void {
    // Absorb errors so Promise.all(inFlight) in the finally block never rejects.
    const done = dispatchStream(stream).catch(() => {});
    inFlight.add(done);
    done.finally(() => inFlight.delete(done));
  }

  const callbacks: H2StreamCallbacks = {
    onBeginHeaders(streamId: number, isTrailers: boolean): void {
      if (isTrailers) {
        const s = streams.get(streamId);
        if (s) s.inTrailers = true;
        return;
      }
      // A second non-trailer HEADERS on an already-open stream.
      if (streams.has(streamId)) {
        const s = streams.get(streamId)!;
        // If the stream is half-closed remote (body already done), this is
        // STREAM_CLOSED; otherwise it is a plain PROTOCOL_ERROR.
        s.headerError = s.bodyDone ? NGHTTP2_STREAM_CLOSED : NGHTTP2_PROTOCOL_ERROR;
        return;
      }
      // Determine initial error: REFUSED_STREAM if over concurrent limit.
      // Never call submitRstStream from onBeginHeaders — the stream is not
      // fully initialized in nghttp2 yet; doing so causes a connection error.
      // Defer the RST to onFrameRecv (END_HEADERS) when the stream is ready.
      const initialError = streams.size >= maxConcurrent ? NGHTTP2_REFUSED_STREAM : null;
      streams.set(streamId, {
        streamId,
        method: 'GET', path: '/', scheme: 'https', authority: 'localhost',
        headers: new Headers(),
        trailerHeaders: new Headers(),
        inTrailers: false,
        bodyChunks: [],
        bodyDone: false,
        cancelled: false,
        triggerDispatch: null,
        seenPseudos: new Set(),
        seenRegularHeader: false,
        headerError: initialError,
      });
    },

    onHeader(streamId: number, name: string, value: string, _flags: number): void {
      const s = streams.get(streamId);
      if (!s || s.headerError !== null) return;

      if (s.inTrailers) {
        // Pseudo-headers must not appear in trailers (RFC 7540 §8.1.2.1).
        if (name.startsWith(':')) { s.headerError = NGHTTP2_PROTOCOL_ERROR; return; }
        s.trailerHeaders.append(name, value);
        return;
      }

      if (name.startsWith(':')) {
        // Pseudo-header after a regular header field (RFC 7540 §8.1.2.1).
        if (s.seenRegularHeader) { s.headerError = NGHTTP2_PROTOCOL_ERROR; return; }
        // Only the four request pseudo-headers are valid (RFC 7540 §8.1.2.3).
        if (name !== ':method' && name !== ':path' && name !== ':scheme' && name !== ':authority') {
          s.headerError = NGHTTP2_PROTOCOL_ERROR; return;
        }
        // Duplicate pseudo-header (RFC 7540 §8.1.2.3).
        if (s.seenPseudos.has(name)) { s.headerError = NGHTTP2_PROTOCOL_ERROR; return; }
        s.seenPseudos.add(name);
        switch (name) {
          case ':method':    s.method    = value; break;
          case ':path':      s.path      = value; break;
          case ':scheme':    s.scheme    = value; break;
          case ':authority': s.authority = value; break;
        }
      } else {
        s.seenRegularHeader = true;
        // Uppercase header field names are invalid in HTTP/2 (RFC 7540 §8.1.2).
        if (_hasUppercase(name)) { s.headerError = NGHTTP2_PROTOCOL_ERROR; return; }
        // Connection-specific headers are forbidden (RFC 7540 §8.1.2.2).
        if (_FORBIDDEN_HEADERS.has(name)) { s.headerError = NGHTTP2_PROTOCOL_ERROR; return; }
        // TE header must only carry "trailers" (RFC 7540 §8.1.2.2).
        if (name === 'te' && value !== 'trailers') { s.headerError = NGHTTP2_PROTOCOL_ERROR; return; }
        s.headers.append(name, value);
      }
    },

    onFrameRecv(streamId: number, frameType: number, frameFlags: number): void {
      // GOAWAY is connection-level (stream 0) — no per-stream entry.
      if (frameType === NGHTTP2_FRAME_TYPE_GOAWAY) {
        receivedGoaway = true;
        return;
      }

      const s = streams.get(streamId);
      if (!s) return;
      const endStream = (frameFlags & NGHTTP2_FLAG_END_STREAM) !== 0;

      if (frameType === NGHTTP2_FRAME_TYPE_HEADERS) {
        if ((frameFlags & NGHTTP2_FLAG_END_HEADERS) === 0) return;

        if (s.inTrailers) {
          if (s.headerError !== null) {
            try { session.submitRstStream(streamId, s.headerError); } catch {}
            s.cancelled = true;
            if (s.triggerDispatch) { s.triggerDispatch(); s.triggerDispatch = null; }
            // Leave stream in map; onStreamClose will clean up.
            return;
          }
          // Trailers with END_STREAM unblock the body wait.
          if (endStream) {
            s.bodyDone = true;
            if (s.triggerDispatch) { s.triggerDispatch(); s.triggerDispatch = null; }
          }
          return;
        }

        // Validate required pseudo-headers once END_HEADERS is received.
        if (s.headerError === null) {
          if (s.method === 'CONNECT') {
            if (!s.authority || s.seenPseudos.has(':path') || s.seenPseudos.has(':scheme')) {
              s.headerError = NGHTTP2_PROTOCOL_ERROR;
            }
          } else {
            if (!s.seenPseudos.has(':method') || !s.seenPseudos.has(':path') || !s.seenPseudos.has(':scheme')) {
              s.headerError = NGHTTP2_PROTOCOL_ERROR;
            } else if (s.path === '') {
              s.headerError = NGHTTP2_PROTOCOL_ERROR;
            }
          }
        }

        if (s.headerError !== null) {
          try { session.submitRstStream(streamId, s.headerError); } catch {}
          // Leave stream in map; onStreamClose will clean up.
          return;
        }

        if (endStream) {
          s.bodyDone = true;
          if (s.triggerDispatch) { s.triggerDispatch(); s.triggerDispatch = null; }
          else startDispatch(s);
        } else {
          startDispatch(s);
        }
      }

      if (frameType === NGHTTP2_FRAME_TYPE_DATA && endStream) {
        s.bodyDone = true;
        if (s.triggerDispatch) { s.triggerDispatch(); s.triggerDispatch = null; }
      }
    },

    onDataChunk(streamId: number, data: Uint8Array): void {
      const s = streams.get(streamId);
      if (!s || s.bodyDone) return;
      s.bodyChunks.push(data);
    },

    onStreamClose(streamId: number, _errorCode: number): void {
      const s = streams.get(streamId);
      if (s) {
        // Always mark cancelled so dispatchStream returns early even if it
        // has not yet awaited triggerDispatch (bodyDone was true at dispatch
        // time — e.g. RST_STREAM arriving before the async handler runs).
        s.cancelled = true;
        if (s.triggerDispatch !== null) {
          s.bodyDone = true;
          s.triggerDispatch();
          s.triggerDispatch = null;
        }
      }
      streams.delete(streamId);
    },
  };

  function drainStreams(): void {
    // Unblock any stream still waiting for a request body that will never arrive
    // (connection dropped before END_STREAM). Without this, Promise.all(inFlight)
    // below would hang forever because dispatchStream is stuck at triggerDispatch.
    for (const [, s] of streams) {
      s.cancelled = true;
      if (s.triggerDispatch !== null) {
        s.bodyDone = true;
        s.triggerDispatch();
        s.triggerDispatch = null;
      }
    }
  }

  return {
    streams,
    inFlight,
    drainWrite,
    drainStreams,
    startDispatch,
    goawayReceived: () => receivedGoaway,
    callbacks,
    setSession: (s: Nghttp2Session) => { session = s; },
  };
}

// ---------------------------------------------------------------------------
// Shared recv loop
// ---------------------------------------------------------------------------

async function _recvLoop(
  reader: BufferedBytesReader,
  writer: BytesWriter,
  session: Nghttp2Session,
  inFlight: Set<Promise<void>>,
  drainWrite: () => Promise<void>,
  drainStreams: () => void,
  goawayReceived: () => boolean,
): Promise<void> {
  try {
    for await (const chunk of reader) {
      const n = await session.recv(chunk);
      if (n < 0) { try { await drainWrite(); } catch {} break; }
      try { await drainWrite(); } catch { break; }
      if (goawayReceived()) break;
    }
  } finally {
    // Unblock streams waiting for bodies that will never arrive (connection
    // dropped before END_STREAM). Must run before Promise.all(inFlight) or
    // the await hangs indefinitely.
    drainStreams();
    await Promise.all([...inFlight]);
    try { session.submitGoaway(0, 0); } catch {}
    try { await drainWrite(); } catch {}
    session.close();
    // BytesReader has no return() so breaking the for-await above does NOT
    // close the reader. Close it explicitly so split() pairs reach closeCount=2
    // and the socket fd is actually released. Writer close triggers fd close.
    try { await reader.close(); } catch {}
    try { await writer.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Build the synthetic stream 1 for h2c upgrade
// ---------------------------------------------------------------------------

function _buildStream1(req: Request): H2ServerStream {
  let path = '/';
  let authority = req.headers.get('host') ?? 'localhost';
  try {
    const parsed = new URL(req.url);
    path = parsed.pathname + parsed.search;
    authority = parsed.host;
  } catch {
    path = req.url;
  }

  const headers = new Headers();
  for (const [k, v] of req.headers.entries()) {
    const lk = k.toLowerCase();
    if (lk === 'connection' || lk === 'upgrade' || lk === 'http2-settings' || lk === 'host') continue;
    headers.append(k, v);
  }

  return {
    streamId: 1,
    method: req.method,
    path,
    scheme: 'http',
    authority,
    headers,
    trailerHeaders: new Headers(),
    inTrailers: false,
    bodyChunks: [],
    // RFC 7540 §3.2: the upgrade request MUST NOT include a request body.
    bodyDone: true,
    cancelled: false,
    triggerDispatch: null,
    seenPseudos: new Set(),
    seenRegularHeader: false,
    headerError: null,
  };
}

// ---------------------------------------------------------------------------
// H2ServerDriver
// ---------------------------------------------------------------------------

export class H2ServerDriver implements ServerDriver {
  async run(
    reader: BufferedBytesReader,
    writer: BytesWriter,
    handler: ServerHandler,
    opts: ServerDriverOptions,
  ): Promise<void> {
    const ctx = _makeCtx(writer, handler, opts.maxConcurrent);
    const session = Nghttp2Session.createServer(ctx.callbacks);
    ctx.setSession(session);
    session.submitSettings([
      [NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS, opts.maxConcurrent],
      [NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE,   65536],
    ]);
    await ctx.drainWrite();
    await _recvLoop(reader, writer, session, ctx.inFlight, ctx.drainWrite, ctx.drainStreams, ctx.goawayReceived);
  }

  /**
   * Run the h2 server after a successful h2c Upgrade handshake.
   *
   * Called by the h1 driver after it has written the 101 Switching Protocols
   * response and handed control of reader/writer to us. `initialReq` is the
   * HTTP/1.1 request that triggered the upgrade; it becomes h2 stream 1.
   * `settingsPayload` is the base64url-decoded `HTTP2-Settings` header value.
   */
  async runFromUpgrade(
    reader: BufferedBytesReader,
    writer: BytesWriter,
    handler: ServerHandler,
    opts: ServerDriverOptions,
    initialReq: Request,
    settingsPayload: Uint8Array,
    headRequest: boolean,
  ): Promise<void> {
    const ctx = _makeCtx(writer, handler, opts.maxConcurrent);
    const session = Nghttp2Session.createServer(ctx.callbacks);
    ctx.setSession(session);
    session.upgradeFromH1(settingsPayload, headRequest);
    session.submitSettings([
      [NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS, opts.maxConcurrent],
      [NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE,   65536],
    ]);
    await ctx.drainWrite();

    const stream1 = _buildStream1(initialReq);
    ctx.streams.set(1, stream1);
    ctx.startDispatch(stream1);

    await _recvLoop(reader, writer, session, ctx.inFlight, ctx.drainWrite, ctx.drainStreams, ctx.goawayReceived);
  }
}
