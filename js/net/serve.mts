/**
 * fino:serve — HTTP/1.1 server convenience.
 *
 * `serve()` wraps `Socket.listen()` and the HTTP parser/serialiser from
 * `fino:http` into a ready-to-use HTTP server that handles keep-alive,
 * Content-Length injection, per-request error isolation, and concurrent
 * connections out of the box.
 *
 *
 * ## Usage
 *
 *   import { serve } from './serve.mts';
 *
 *   const server = serve(lp, { port: 3000 }, async (req) => {
 *     return new Response('hello');
 *   });
 *
 *   // Graceful shutdown:
 *   await server.close();
 *
 *
 * ## Keep-alive
 *
 * HTTP/1.1 connections are kept alive by default. The server loops over
 * requests on the same TCP connection until the client sends
 * `Connection: close`, the handler returns a response with that header, or
 * the connection is reset. The `connectionParser()` helper from `fino:http`
 * shares a single buffered reader across all requests on a connection —
 * required to correctly forward leftover bytes between pipelined requests.
 *
 *
 * ## Content-Length
 *
 * If the handler's Response does not include a `Content-Length` or
 * `Transfer-Encoding` header, `serve()` eagerly buffers the body and injects
 * `Content-Length`. For truly streaming responses, set one of those headers
 * yourself.
 *
 *
 * ## Error handling
 *
 * If the handler throws an unhandled error, `serve()` sends a bare
 * `500 Internal Server Error` response and closes the connection. The handler
 * is responsible for catching its own application errors and returning
 * appropriate responses.
 */

import {
  Headers,
  Response,
  Arena,
  serializeResponse,
  connectionParser,
  buildWireResponse,
  _buildResponseHead,
  _iterableFromBytes,
  _concat,
} from './http.mts';
// Reused across all _writeResponse calls on this module — TextEncoder is stateless.
const _encoder = new TextEncoder();
// Single-slot cache for encoded response head bytes.
// HTTP/1.1 servers often serve the same status+headers repeatedly (e.g. 200 OK with
// the same Content-Type). Caching avoids re-encoding the ASCII head string on every
// request via TextEncoder.encodeInto, which shows up at ~3% flat in profiles.
let _cachedHeadStr  = '';
let _cachedHeadBytes: Uint8Array | null = null;
import { Socket } from './socket.mts';
import { TlsSocket } from './tls.mts';
import { sslCtxLoadCertKey, sslCtxFree } from '../internal/openssl.mts';
import { topic } from '../util/topic.mts';
import { consumeRequestContext, otelRuntimeEvent, otelRuntimeTopic, runWithActiveContext } from '../opentelemetry/common.mts';

// Pre-cache topic instances — avoids encodeSegment() call on every request.
const _topicRequestStart = topic(otelRuntimeTopic('http.server', 'request', 'start'));
const _topicRequestEnd   = topic(otelRuntimeTopic('http.server', 'request', 'end'));
const _topicRequestError = topic(otelRuntimeTopic('http.server', 'request', 'error'));
import { WebSocketConnection } from './websocket.mts';
import type { Request } from './http.mts';
import type { IPv4Address } from './socket.mts';

interface ServeOptions {
  port:      number;
  hostname?: string;
  tls?: {
    cert: string;  // path to PEM certificate file
    key:  string;  // path to PEM private key file
  };
}

interface ServeServer {
  address: { family: string; ip: string; port: number };
  readonly port: number;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether to keep the connection alive after this request.
 * HTTP/1.1 defaults to keep-alive; HTTP/1.0 defaults to close.
 */
function _shouldKeepAlive(reqHeaders: { get(name: string): string | null }, version: string): boolean {
  const conn = (reqHeaders.get('connection') || '').toLowerCase().trim();
  return version === 'HTTP/1.0' ? conn === 'keep-alive' : conn !== 'close';
}

/**
 * Drain any unconsumed request body so the reader advances past the body
 * bytes before the next request's headers are parsed.
 */
async function _drainBody(req: Request): Promise<void> {
  if (!req.hasBody || req.bodyUsed) return;
  const body = req.body;
  if (body === null) return;
  for await (const _ of body) {}
}

/** Prepared wire response. rawBytes is non-null when the body was pre-buffered. */
interface PreparedResponse {
  wire:     InstanceType<typeof Response>;
  rawBytes: Uint8Array | null;
}

type PendingEntry =
  | { kind: 'response'; prepared: PreparedResponse; closeAfter: boolean }
  | { kind: 'upgrade';  conn: WebSocketConnection };

const MAX_PENDING_REQUESTS = 32;
const MAX_BATCH_IOV = 64;
const EMPTY_BYTES = new Uint8Array(0);
let _serverRequestSeq = 0;

/**
 * Prepare a response for the wire:
 *   - Injects `Content-Length` if the body is not already framed.
 *   - Injects `Connection: keep-alive` or `Connection: close`.
 *   - Sets the HTTP version to match the request.
 *
 * Returns the wire Response and, when the body was pre-buffered, the raw bytes
 * so that `_writeResponse` can combine header + body into a single write.
 */
async function _prepareResponse(res: Response, keepAlive: boolean, reqVersion: string): Promise<PreparedResponse> {
  const version    = reqVersion || 'HTTP/1.1';
  const connHeader = keepAlive ? 'keep-alive' : 'close';

  const alreadyFramed = res.headers.has('content-length') ||
                        res.headers.has('transfer-encoding');

  // Fast path: pre-buffered byte body with no framing header (new Response('...') or
  // new Response(bytes) without Transfer-Encoding). Avoids ReadableStream.from() + async
  // iteration just to recover bytes we already have. Cannot be used when alreadyFramed
  // because serializeResponse is needed to apply chunked encoding.
  if (!alreadyFramed) {
    const bodyBytes = res._extractBytes();
    if (bodyBytes !== null) {
      const headers = new Headers(res.headers);
      headers.set('content-length', String(bodyBytes.byteLength));
      headers.set('connection', connHeader);
      return {
        wire: buildWireResponse({ version, status: res.status, statusText: res.statusText, headers, body: null }),
        rawBytes: bodyBytes,
      };
    }
  }

  // Slow path: null body, streaming async iterable body, or already-framed body.
  const rawBody = res.body; // sets bodyUsed = true; null or ReadableStream

  if (rawBody === null || alreadyFramed) {
    const headers = new Headers(res.headers);
    headers.set('connection', connHeader);
    return {
      wire: buildWireResponse({ version, status: res.status, statusText: res.statusText, headers, body: rawBody }),
      rawBytes: rawBody === null ? EMPTY_BYTES : null,
    };
  }

  // Buffer the entire streaming body so we can inject Content-Length.
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of rawBody) {
    const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    parts.push(u8);
    total += u8.byteLength;
  }
  const bytes = total === 0 ? EMPTY_BYTES : _concat(parts, total);
  const headers = new Headers(res.headers);
  headers.set('content-length', String(bytes.byteLength));
  headers.set('connection', connHeader);
  return {
    wire: buildWireResponse({ version, status: res.status, statusText: res.statusText, headers, body: null }),
    rawBytes: bytes,
  };
}

/**
 * Return encoded bytes for `headStr`, using a single-slot module-level cache.
 * HTTP servers routinely repeat the same status + headers (e.g. 200 + Content-Type
 * + Content-Length + Connection). Caching avoids re-encoding on every request.
 * On a miss the bytes are allocated once; on a hit we return the existing buffer.
 */
function _getHeadBuf(headStr: string): Uint8Array {
  if (headStr === _cachedHeadStr && _cachedHeadBytes !== null) return _cachedHeadBytes;
  const buf = new Uint8Array(headStr.length);
  _encoder.encodeInto(headStr, buf);
  _cachedHeadStr  = headStr;
  _cachedHeadBytes = buf;
  return buf;
}

/**
 * Write a prepared response to the socket.
 *
 * Fast path: when rawBytes is non-null (body was pre-buffered), combines the
 * ASCII header string and the body into one contiguous arena buffer and issues
 * a single write(2) syscall instead of two.
 *
 * Slow path: streaming/chunked body — falls back to writer.pipe(serializeResponse(...)).
 */
async function _writeResponse(writer: { writev(vecs: Uint8Array[], count: number): Promise<void>; pipe(source: AsyncIterable<Uint8Array | ArrayBuffer>): Promise<void> }, prepared: PreparedResponse, arena: Arena, vecs: Uint8Array[]): Promise<void> {
  const { wire, rawBytes } = prepared;
  if (rawBytes !== null) {
    const headBuf = _getHeadBuf(_buildResponseHead(wire));
    vecs[0] = headBuf;
    vecs[1] = rawBytes;
    await writer.writev(vecs, rawBytes.byteLength === 0 ? 1 : 2);
  } else {
    // Slow path: streaming or null body.
    await writer.pipe(serializeResponse(wire, arena));
  }
}

async function _writeResponseBatch(writer: { writev(vecs: Uint8Array[], count: number): Promise<void>; pipe(source: AsyncIterable<Uint8Array | ArrayBuffer>): Promise<void> }, batch: PreparedResponse[], arena: Arena, vecs: Uint8Array[]): Promise<void> {
  let vecCount = 0;
  let totalBytes = 0;

  async function flushVecs() {
    if (vecCount === 0) return;
    await writer.writev(vecs, vecCount);
    vecCount = 0;
    totalBytes = 0;
    arena.reset();
  }

  for (const prepared of batch) {
    if (prepared.rawBytes === null) {
      await flushVecs();
      await _writeResponse(writer, prepared, arena, vecs);
      arena.reset();
      continue;
    }

    const headStr = _buildResponseHead(prepared.wire);
    const bodyBytes = prepared.rawBytes;
    const responseBytes = headStr.length + bodyBytes.byteLength;
    const neededVecs = bodyBytes.byteLength === 0 ? 1 : 2;

    if (vecCount > 0 && (vecCount + neededVecs > MAX_BATCH_IOV || totalBytes + responseBytes > 65536)) {
      await flushVecs();
    }

    const headBuf = _getHeadBuf(headStr);
    vecs[vecCount++] = headBuf;
    totalBytes += headBuf.byteLength;

    if (bodyBytes.byteLength > 0) {
      vecs[vecCount++] = bodyBytes;
      totalBytes += bodyBytes.byteLength;
    }
  }

  await flushVecs();
}

/**
 * Handle a single accepted TCP connection: parse requests, call the handler,
 * send responses, loop on keep-alive until the client closes.
 */
async function _handleConnection(conn: InstanceType<typeof Socket>, handler: (req: Request) => Response | WebSocketConnection | Promise<Response | WebSocketConnection>): Promise<void> {
  const [reader, writer] = conn.split();
  const parser = connectionParser(reader);
  const arena = new Arena(65536);
  const vecs: Uint8Array[] = new Array(MAX_BATCH_IOV);
  const pending = new Map<number, PendingEntry>();
  let nextSeq = 0;
  let nextWriteSeq = 0;
  let inFlight = 0;
  let readPumpActive = false;
  let flushActive = false;
  let parserDone = false;
  let connectionFailed = false;
  let stopAfterSeq = Number.POSITIVE_INFINITY;
  let notifier: (() => void) | null = null;

  function notify() {
    const resolve = notifier;
    notifier = null;
    if (resolve) resolve();
  }

  function queuedCount() {
    return nextSeq - nextWriteSeq;
  }

  function hasReadyResponses() {
    return pending.has(nextWriteSeq);
  }

  function shouldReadMore() {
    return !parserDone && !connectionFailed && nextSeq < stopAfterSeq && queuedCount() < MAX_PENDING_REQUESTS;
  }

  async function pumpReads() {
    if (readPumpActive || !shouldReadMore()) return;
    readPumpActive = true;
    try {
      let bufferedOnly = false;
      while (shouldReadMore()) {
        let req: Request | null;
        try {
          req = bufferedOnly ? parser.parseBufferedNext() : await parser.parseNext();
        } catch (e) {
          parserDone = true;
          break;
        }
        if (req === null) break;

        const seq = nextSeq++;
        // Only allocate requestId when OTel has subscribers — avoids string
        // concatenation on every request in the common no-collector case.
        const otelActive = _topicRequestStart.hasSubscribers || _topicRequestEnd.hasSubscribers || _topicRequestError.hasSubscribers;
        const requestId = otelActive ? 'http-server-' + (++_serverRequestSeq) : '';
        let keepAlive = _shouldKeepAlive(req.headers, req.version);
        if (!keepAlive && seq < stopAfterSeq) stopAfterSeq = seq;
        inFlight++;

        if (_topicRequestStart.hasSubscribers) {
          _topicRequestStart.publish(otelRuntimeEvent('http.server', 'request', 'start', {
            requestId,
            method: req.method,
            route: new URL(req.url).pathname,
            url: req.url,
            headers: Object.fromEntries(req.headers.entries()),
            timeUnixNano: Date.now() * 1_000_000,
          }));
        }

        // Consume any active span context installed by http-server instrumentation
        // so that user code inside the handler can read it via getActiveSpanContext().
        const _requestContext = otelActive ? consumeRequestContext(requestId) : null;
        const _handleAsync = async () => {
          let res: Response | WebSocketConnection;
          try {
            res = await handler(req);
          } catch (e) {
            res = new Response('Internal Server Error', { status: 500 });
            keepAlive = false;
            if (_topicRequestError.hasSubscribers) {
              _topicRequestError.publish(otelRuntimeEvent('http.server', 'request', 'error', {
                requestId,
                method: req.method,
                route: new URL(req.url).pathname,
                url: req.url,
                error: e,
                timeUnixNano: Date.now() * 1_000_000,
              }));
            }
          }

          // WebSocket upgrade: hand off to the connection and stop HTTP on this conn.
          if (res instanceof WebSocketConnection) {
            if (seq < stopAfterSeq) stopAfterSeq = seq;
            parserDone = true;
            pending.set(seq, { kind: 'upgrade', conn: res });
            inFlight--;
            notify();
            return;
          }

          try {
            await _drainBody(req);
          } catch (e) {
            keepAlive = false;
          }

          if ((res.headers.get('connection') || '').toLowerCase().trim() === 'close') {
            keepAlive = false;
          }
          if (!keepAlive && seq < stopAfterSeq) stopAfterSeq = seq;

          let prepared: PreparedResponse;
          try {
            prepared = await _prepareResponse(res, keepAlive, req.version);
            if (_topicRequestEnd.hasSubscribers) {
              _topicRequestEnd.publish(otelRuntimeEvent('http.server', 'request', 'end', {
                requestId,
                method: req.method,
                route: new URL(req.url).pathname,
                url: req.url,
                statusCode: res.status,
                timeUnixNano: Date.now() * 1_000_000,
              }));
            }
          } catch (e) {
            prepared = {
              wire: buildWireResponse({
                version: req.version || 'HTTP/1.1',
                status: 500,
                statusText: 'Internal Server Error',
                headers: new Headers({ connection: 'close' }),
                body: null,
              }),
              rawBytes: EMPTY_BYTES,
            };
            keepAlive = false;
            if (seq < stopAfterSeq) stopAfterSeq = seq;
            if (_topicRequestError.hasSubscribers) {
              _topicRequestError.publish(otelRuntimeEvent('http.server', 'request', 'error', {
                requestId,
                method: req.method,
                route: new URL(req.url).pathname,
                url: req.url,
                error: e,
                timeUnixNano: Date.now() * 1_000_000,
              }));
            }
          }

          pending.set(seq, { kind: 'response', prepared, closeAfter: !keepAlive });
          inFlight--;
          notify();
        };
        void (_requestContext ? runWithActiveContext(_requestContext, _handleAsync) : _handleAsync());

        bufferedOnly = !req.hasBody;
        if (req.hasBody) break;
      }
    } finally {
      readPumpActive = false;
      notify();
    }
  }

  async function flushResponses() {
    if (flushActive || !hasReadyResponses()) return;
    flushActive = true;
    try {
      while (hasReadyResponses()) {
        const entry = pending.get(nextWriteSeq);
        if (entry === undefined) break;
        pending.delete(nextWriteSeq);
        nextWriteSeq++;

        // WebSocket upgrade: hand the reader/writer to the connection and await it.
        if (entry.kind === 'upgrade') {
          try {
            await entry.conn._takeOver(reader, writer);
          } catch (_) {}
          // After the WebSocket closes, _handleConnection's finally will clean up.
          return;
        }

        // Normal HTTP response batch
        const batch: PreparedResponse[] = [];
        let closeAfter = false;
        batch.push(entry.prepared);
        closeAfter = entry.closeAfter;

        while (!closeAfter && pending.has(nextWriteSeq) && batch.length < MAX_PENDING_REQUESTS) {
          const current = pending.get(nextWriteSeq);
          if (current === undefined || current.kind === 'upgrade') break;
          pending.delete(nextWriteSeq);
          batch.push(current.prepared);
          closeAfter = current.closeAfter;
          nextWriteSeq++;
          if (closeAfter) break;
        }

        try {
          await _writeResponseBatch(writer, batch, arena, vecs);
          await writer.flush();
        } catch (e) {
          connectionFailed = true;
          break;
        } finally {
          arena.reset();
        }

        if (closeAfter) {
          parserDone = true;
          break;
        }
      }
    } finally {
      flushActive = false;
      notify();
    }
  }

  try {
    while (true) {
      if (!readPumpActive && shouldReadMore()) void pumpReads();
      if (!flushActive && hasReadyResponses()) void flushResponses();

      if (connectionFailed) break;
      if (parserDone && inFlight === 0 && pending.size === 0 && !readPumpActive && !flushActive) {
        break;
      }

      await new Promise<void>(resolve => { notifier = resolve; });
    }
  } finally {
    await writer.close();
    await reader.close();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start an HTTP/1.1 server.
 *
 * Each incoming connection is handled concurrently. The event loop is
 * implicitly kept alive as long as the server is open.
 *
 * @param {object} lp — loop handle from fino:loop
 * @param {{ port: number, hostname?: string }} options
 * @param {(req: Request) => Response | Promise<Response>} handler
 * @returns {{ address: object, port: number, close(): Promise<void> }}
 *
 * @example
 * import { serve } from './serve.mts';
 *
 * const server = serve({ port: 3000 }, async (req) => new Response('hello'));
 * // ... handle some requests ...
 * await server.close();
 */
export function serve(options: ServeOptions, handler: (req: Request) => Response | WebSocketConnection | Promise<Response | WebSocketConnection>): ServeServer {
  const hostname = options.hostname ?? '0.0.0.0';
  const port     = options.port ?? 0;

  const addr: IPv4Address = { family: 'ipv4', ip: hostname, port };
  const tcpServer = Socket.listen(addr);

  // If TLS options are provided, load the certificate and private key once
  // for the lifetime of the server. The sslCtx is shared across all accepted
  // connections (TlsSocket.accept does not take ownership of it).
  let sslCtx = options.tls ? sslCtxLoadCertKey(options.tls.cert, options.tls.key) : null;

  const inFlight = new Set<Promise<void>>();
  let acceptLoopDone = false;
  let finishResolve: (() => void) | null = null;
  const finished = new Promise<void>(function captureFinishResolve(resolve) { finishResolve = resolve; });

  // Close signal — resolved by close() to unblock any pending loop.readable()
  // inside acceptOne(). Without this, closing the server fd leaves the accept
  // loop suspended at loop.readable(lp, serverFd) forever.
  let closeSignalResolve: (() => void) | null = null;
  const closeSignal = new Promise<null>(function captureCloseResolve(resolve) { closeSignalResolve = () => resolve(null); });

  const boundAddress = tcpServer.address;
  if (boundAddress.family !== 'ipv4' && boundAddress.family !== 'ipv6') {
    if (sslCtx !== null) { sslCtxFree(sslCtx); sslCtx = null; }
    throw new TypeError('serve: expected an IP server address');
  }

  function _checkDone() {
    if (acceptLoopDone && inFlight.size === 0 && finishResolve) finishResolve();
  }

  // Accept loop — runs concurrently; each connection is fire-and-forget.
  (async function acceptLoop() {
    try {
      while (true) {
        const tcpConn: Awaited<ReturnType<typeof tcpServer.accept>> | null = await Promise.race([tcpServer.accept(), closeSignal]);
        if (tcpConn === null || tcpConn === undefined) break; // closed

        let connPromise: Promise<void>;
        if (sslCtx !== null) {
          // Wrap the accepted TCP socket in a TlsSocket (server-side handshake).
          // TlsSocket.accept takes ownership of the fd; the plain tcpConn object
          // is abandoned (not closed) on success so the fd is not double-closed.
          // On handshake failure, close the TCP socket to release the fd.
          connPromise = TlsSocket.accept(tcpConn.fd, sslCtx).then(
            function handleTlsConn(tlsConn) {
              return _handleConnection(tlsConn, handler);
            },
            function tlsHandshakeError(err: unknown) {
              tcpConn.close();
              // Log so TLS errors are visible — a flood of bad-TLS clients would
              // otherwise be completely invisible in production.
              if (typeof console !== 'undefined') {
                console.error('fino:serve TLS handshake failed:', err);
              }
            },
          );
        } else {
          connPromise = _handleConnection(tcpConn, handler);
        }

        inFlight.add(connPromise);
        connPromise.finally(function cleanupConnection() { inFlight.delete(connPromise); _checkDone(); });
      }
    } finally {
      acceptLoopDone = true;
      _checkDone();
    }
  })().catch(function swallowAcceptError() {}); // swallow unhandled rejections from the accept loop

  return {
    /** The address the server is listening on. */
    address: boundAddress,
    /** Convenience shortcut for server.address.port. */
    get port() { return boundAddress.port; },
    /**
     * Stop accepting new connections and wait for all in-flight connections
     * to finish. Returns a Promise that resolves when the server is fully shut down.
     */
    close(): Promise<void> {
      if (closeSignalResolve) closeSignalResolve(); // wake the accept loop
      tcpServer.close();
      // Guard against double-free if close() is called more than once.
      if (sslCtx !== null) { sslCtxFree(sslCtx); sslCtx = null; }
      return finished;
    },
  };
}
