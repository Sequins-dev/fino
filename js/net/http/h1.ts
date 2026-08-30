/**
 * internal:net/http/h1 — HTTP/1.1 server and client protocol drivers.
 *
 * This module provides the two protocol drivers that read and write HTTP/1.1
 * messages over an already-connected `BytesReader`/`BytesWriter` pair. It sits
 * below the public `serve()` and `fetch()` surfaces: the caller owns DNS, the
 * TCP/TLS connection, redirect following, pooling, and body wrapping, while
 * these drivers own only the on-the-wire framing of one connection.
 *
 * `H1ServerDriver.run()` drives one accepted connection end to end. It parses
 * pipelined requests, runs the handler with bounded concurrency while
 * preserving response order, honours `Connection: keep-alive`/`close` and
 * `Expect: 100-continue`, batches queued responses into a single `writev`, and
 * emits OpenTelemetry runtime events. When `allowH2cUpgrade` is set it detects
 * an `Upgrade: h2c` prior-knowledge upgrade and hands the socket off to the
 * HTTP/2 server driver. Handler-returned `ConnectionTakeover` values (used for
 * WebSocket and other protocol switches) are also honoured.
 *
 * `H1ClientDriver.send()` serialises one `Request`, flushes it, and parses the
 * matching `Response` on the supplied reader/writer. HTTP/1.1 is not
 * multiplexed, so callers must serialise requests per connection; the driver
 * leaves the socket open on success so the caller can pool or reuse it.
 *
 * Both drivers assume the framing rules of RFC 9112 messaging and the semantics
 * of RFC 9110; see those documents for header and body-length behaviour.
 *
 * ```ts no_run
 * import { H1ServerDriver, H1ClientDriver } from 'internal:net/http/h1';
 * import { Response } from 'internal:net/http/wire';
 *
 * // Server: drive one accepted connection.
 * await new H1ServerDriver().run(reader, writer, async () => new Response('ok'), {
 *   maxConcurrent: 32,
 *   allowH2cUpgrade: true,
 * });
 *
 * // Client: send one request over an open socket.
 * const res = await new H1ClientDriver().send(req, reader, writer, { signal: null });
 * ```
 *
 * HTTP/1.1 messaging: https://www.rfc-editor.org/rfc/rfc9112
 * HTTP semantics: https://www.rfc-editor.org/rfc/rfc9110
 *
 * @internal
 */
import {
  Arena,
  serializeResponse,
  serializeRequest,
  parseResponse,
  connectionParser,
  buildWireResponse,
  _buildResponseHead,
  _concat,
  Headers,
  Response,
} from './index.ts';
import type { Request } from './index.ts';
import { TextEncoder as _TextEncoder } from '../../globals/encoding.ts';
import { atob } from '../../globals/encoding.ts';
import type { BytesReader, BytesWriter } from '../../internal/stream.ts';
import type {
  ServerDriver,
  ClientDriver,
  ServerDriverOptions,
  ClientDriverOptions,
  ServerHandler,
  CancelSignal,
} from './driver.ts';
import { isConnectionTakeover } from './driver.ts';
import type { ConnectionTakeover } from './driver.ts';
import { h2Available } from '../../internal/net/http/h2/bindings.ts';
import { H2ServerDriver } from '../../internal/net/http/h2/server.ts';
import * as loop from '../../internal/runtime/loop.ts';
import { topic } from '../../context/topic.ts';
import { Scanner } from '../../parsing/scanner.ts';
import {
  consumeRequestContext,
  otelRuntimeEvent,
  otelRuntimeTopic,
  runWithActiveContext,
} from '../../internal/opentelemetry/common.ts';
// ---------------------------------------------------------------------------
// Module-level shared state
// ---------------------------------------------------------------------------
const _encoder = new _TextEncoder();
// Single-slot cache for encoded response head bytes.
// HTTP/1.1 servers often serve the same status+headers repeatedly (e.g. 200 OK with
// the same Content-Type). Caching avoids re-encoding the ASCII head string on every
// request via TextEncoder.encodeInto, which shows up at ~3% flat in profiles.
let _cachedHeadStr = '';
let _cachedHeadBytes: Uint8Array | null = null;
// Pre-cache topic instances — avoids encodeSegment() call on every request.
const _topicRequestStart = topic(otelRuntimeTopic('http.server', 'request', 'start'));
const _topicRequestEnd = topic(otelRuntimeTopic('http.server', 'request', 'end'));
const _topicRequestError = topic(otelRuntimeTopic('http.server', 'request', 'error'));
let _serverRequestSeq = 0;
const MAX_PENDING_REQUESTS = 32;
const MAX_BATCH_IOV = 64;
const EMPTY_BYTES = new Uint8Array(0);
// ---------------------------------------------------------------------------
// h2c Upgrade helpers
// ---------------------------------------------------------------------------
function _decodeBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function _isH2cUpgrade(req: Request): boolean {
  if ((req.headers.get('upgrade') ?? '').toLowerCase() !== 'h2c') return false;
  const scanner = new Scanner(req.headers.get('connection') ?? '', {
    encoding: 'ascii',
    format: 'http',
  });
  return scanner.readDelimitedList(',').some((token) => token.toLowerCase() === 'http2-settings');
}
// 101 Switching Protocols response written before handing off to the h2 driver.
const _101 = new _TextEncoder().encode(
  'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n',
);
const _100 = new _TextEncoder().encode('HTTP/1.1 100 Continue\r\n\r\n');
class _H2cUpgradeTakeover implements ConnectionTakeover {
  readonly compatibleProtocols: ReadonlySet<string> = new Set(['http/1.1']);
  readonly #handler: ServerHandler;
  readonly #opts: ServerDriverOptions;
  readonly #req: Request;
  readonly #settingsPayload: Uint8Array;
  readonly #headRequest: boolean;
  constructor(
    handler: ServerHandler,
    opts: ServerDriverOptions,
    req: Request,
    settingsPayload: Uint8Array,
    headRequest: boolean,
  ) {
    this.#handler = handler;
    this.#opts = opts;
    this.#req = req;
    this.#settingsPayload = settingsPayload;
    this.#headRequest = headRequest;
  }
  async _takeOver(reader: BytesReader, writer: BytesWriter): Promise<void> {
    await writer.write(_101);
    await writer.flush();
    const h2Driver = new H2ServerDriver();
    await h2Driver.runFromUpgrade(
      reader as any,
      writer,
      this.#handler,
      this.#opts,
      this.#req,
      this.#settingsPayload,
      this.#headRequest,
    );
  }
}
// ---------------------------------------------------------------------------
// Abort-race helper (used by H1ClientDriver.send())
// ---------------------------------------------------------------------------
function _raceAbort<T>(signal: CancelSignal | null | undefined, promise: Promise<T>): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  const activeSignal = signal;
  return new Promise(function raceAbortExecutor(resolve, reject) {
    function onAbort() {
      reject(activeSignal.reason);
    }
    activeSignal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      function onFulfilled(v) {
        activeSignal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      function onRejected(e) {
        activeSignal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
// ---------------------------------------------------------------------------
// H1 server-side helpers (moved from serve.ts)
// ---------------------------------------------------------------------------
function _shouldKeepAlive(
  reqHeaders: {
    get(name: string): string | null;
  },
  version: string,
): boolean {
  const conn = (reqHeaders.get('connection') || '').toLowerCase().trim();
  return version === 'HTTP/1.0' ? conn === 'keep-alive' : conn !== 'close';
}
async function _drainBody(req: Request): Promise<void> {
  if (!req.hasBody || req.bodyUsed) return;
  const body = req.body;
  if (body === null) return;
  for await (const _ of body) {
  }
}
interface PreparedResponse {
  wire: InstanceType<typeof Response>;
  rawBytes: Uint8Array | null;
}
type PendingEntry =
  | {
      kind: 'response';
      prepared: PreparedResponse;
      closeAfter: boolean;
    }
  | {
      kind: 'upgrade';
      conn: ConnectionTakeover;
    };
type ParseResult =
  | {
      kind: 'request';
      req: Request | null;
    }
  | {
      kind: 'headers-timeout';
    }
  | {
      kind: 'idle-timeout';
    };
async function _prepareResponse(
  res: Response,
  keepAlive: boolean,
  reqVersion: string,
): Promise<PreparedResponse> {
  const version = reqVersion || 'HTTP/1.1';
  const connHeader = keepAlive ? 'keep-alive' : 'close';
  const hasOutTrailers = res._hasOutTrailers();
  const alreadyFramed = res.headers.has('content-length') || res.headers.has('transfer-encoding');
  const noBodyStatus = res.status === 204 || (res.status >= 100 && res.status < 200);
  // Out-trailers require streaming via serializeResponse — skip pre-buffering.
  if (!alreadyFramed && !hasOutTrailers) {
    const bodyBytes = res._extractBytes();
    if (bodyBytes !== null) {
      const headers = new Headers(res.headers);
      if (!noBodyStatus) headers.set('content-length', String(bodyBytes.byteLength));
      headers.set('connection', connHeader);
      return {
        wire: buildWireResponse({
          version,
          status: res.status,
          statusText: res.statusText,
          headers,
          body: null,
        }),
        rawBytes: noBodyStatus ? EMPTY_BYTES : bodyBytes,
      };
    }
  }
  const rawBody = res.body;
  // Chunked TE with null body still needs the terminal "0\r\n\r\n" — use slow path.
  const hasChunkedTE = (res.headers.get('transfer-encoding') || '')
    .toLowerCase()
    .includes('chunked');
  if (rawBody === null || (alreadyFramed && !hasOutTrailers)) {
    const headers = new Headers(res.headers);
    if (headers.has('transfer-encoding')) headers.delete('content-length');
    headers.set('connection', connHeader);
    return {
      wire: buildWireResponse({
        version,
        status: res.status,
        statusText: res.statusText,
        headers,
        body: rawBody,
      }),
      rawBytes: rawBody === null && !hasChunkedTE ? EMPTY_BYTES : null,
    };
  }
  // Trailers or streaming body: route through serializeResponse (rawBytes = null).
  if (hasOutTrailers) {
    const headers = new Headers(res.headers);
    headers.set('connection', connHeader);
    return {
      wire: buildWireResponse({
        version,
        status: res.status,
        statusText: res.statusText,
        headers,
        body: rawBody,
        outTrailers: res._getRawOutTrailers(),
      }),
      rawBytes: null,
    };
  }
  // HTTP/1.0 has no chunked transfer coding, so retain the compatibility path
  // that buffers an otherwise unframed body and emits Content-Length.
  if (version === 'HTTP/1.0') {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of rawBody) {
      const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      parts.push(u8);
      total += u8.byteLength;
    }
    const bytes = total === 0 ? EMPTY_BYTES : _concat(parts, total);
    const headers = new Headers(res.headers);
    if (!noBodyStatus) headers.set('content-length', String(bytes.byteLength));
    headers.set('connection', connHeader);
    return {
      wire: buildWireResponse({
        version,
        status: res.status,
        statusText: res.statusText,
        headers,
        body: null,
      }),
      rawBytes: bytes,
    };
  }
  // RFC 9112 sections 6.3 and 7.1: an HTTP/1.1 stream whose size is not
  // known in advance is length-delimited with chunked transfer coding. This
  // sends headers and each body chunk immediately instead of waiting for EOF.
  const headers = new Headers(res.headers);
  headers.set('transfer-encoding', 'chunked');
  headers.set('connection', connHeader);
  return {
    wire: buildWireResponse({
      version,
      status: res.status,
      statusText: res.statusText,
      headers,
      body: rawBody,
    }),
    rawBytes: null,
  };
}
function _getHeadBuf(headStr: string): Uint8Array {
  if (headStr === _cachedHeadStr && _cachedHeadBytes !== null) return _cachedHeadBytes;
  const buf = new Uint8Array(headStr.length);
  _encoder.encodeInto(headStr, buf);
  _cachedHeadStr = headStr;
  _cachedHeadBytes = buf;
  return buf;
}
async function _writeResponse(
  writer: BytesWriter,
  prepared: PreparedResponse,
  arena: Arena,
  vecs: Uint8Array[],
): Promise<void> {
  const { wire, rawBytes } = prepared;
  if (rawBytes !== null) {
    const headBuf = _getHeadBuf(_buildResponseHead(wire));
    vecs[0] = headBuf;
    vecs[1] = rawBytes;
    await writer.writev(vecs, rawBytes.byteLength === 0 ? 1 : 2);
  } else {
    for await (const chunk of serializeResponse(wire, arena)) {
      await writer.write(chunk as Uint8Array);
      await writer.flush();
    }
  }
}
async function _writeResponseBatch(
  writer: BytesWriter,
  batch: PreparedResponse[],
  arena: Arena,
  vecs: Uint8Array[],
): Promise<void> {
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
    if (
      vecCount > 0 &&
      (vecCount + neededVecs > MAX_BATCH_IOV || totalBytes + responseBytes > 65536)
    ) {
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
// ---------------------------------------------------------------------------
// H1ServerDriver
// ---------------------------------------------------------------------------
/**
 * HTTP/1.1 server protocol driver for one accepted connection.
 *
 * The driver runs an internal read/flush loop: a read pump parses pipelined
 * requests up to `maxConcurrent` in flight and hands each to the handler, while
 * a flush pump writes completed responses back in request order, coalescing
 * adjacent buffered responses into batched `writev` calls. It transparently
 * handles `Expect: 100-continue` (replying `100 Continue` before reading the
 * body), `Connection` keep-alive/close negotiation, request-body draining
 * before connection reuse, h2c upgrades when `allowH2cUpgrade` is enabled, and
 * handler-returned `ConnectionTakeover` handoffs.
 *
 * A single instance is stateless between connections and may be reused for
 * every accepted socket; all per-connection state lives inside `run()`.
 *
 * ```ts no_run
 * import { H1ServerDriver } from 'internal:net/http/h1';
 * import { Response } from 'internal:net/http/wire';
 *
 * const driver = new H1ServerDriver();
 * for await (const conn of listener) {
 *   void driver.run(conn.reader, conn.writer, async (req) => {
 *     return new Response(`hello ${new URL(req.url).pathname}`);
 *   }, { maxConcurrent: 32, allowH2cUpgrade: true });
 * }
 * ```
 */
export class H1ServerDriver implements ServerDriver {
  /**
   * Process one HTTP/1.1 connection until EOF, close, upgrade, or error.
   *
   * Pipelined requests are parsed and dispatched concurrently up to
   * `opts.maxConcurrent`, but responses are always written in request order.
   * Handler exceptions become a `500 Internal Server Error` and close the
   * connection; a headers-parse timeout produces `408 Request Timeout` and an
   * unsupported `Expect` header produces `417 Expectation Failed`, both of which
   * also close the connection. Request bodies are drained before a connection is
   * reused for keep-alive. An idle timeout between requests closes the connection
   * cleanly with no response.
   *
   * If the handler returns a `ConnectionTakeover` (or an h2c upgrade is
   * detected), the raw reader/writer are handed to that protocol and this driver
   * stops. The returned promise resolves only after both I/O halves have been
   * closed, so awaiting it means the connection is fully torn down.
   *
   * ```ts no_run
   * await new H1ServerDriver().run(reader, writer, async (req) => {
   *   if (req.url.endsWith('/health')) return new Response('ok');
   *   return new Response('not found', { status: 404 });
   * }, { maxConcurrent: 8, idleTimeoutMs: 5000, headersTimeoutMs: 10000 });
   * ```
   */
  async run(
    reader: BytesReader,
    writer: BytesWriter,
    handler: ServerHandler,
    opts: ServerDriverOptions,
  ): Promise<void> {
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
    let bodyDrainCount = 0;
    const maxConcurrent = opts.maxConcurrent;
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
      return (
        !parserDone &&
        !connectionFailed &&
        bodyDrainCount === 0 &&
        // Only the active pump may inspect already-buffered pipelined requests
        // while a handler might still transfer reader ownership via takeover.
        (readPumpActive || inFlight === 0) &&
        nextSeq < stopAfterSeq &&
        queuedCount() < maxConcurrent
      );
    }
    function shouldStop() {
      return (
        connectionFailed ||
        (parserDone && inFlight === 0 && pending.size === 0 && !readPumpActive && !flushActive)
      );
    }
    async function makeCloseResponse(
      status: number,
      body: string,
      reqVersion = 'HTTP/1.1',
    ): Promise<PreparedResponse> {
      return _prepareResponse(new Response(body, { status }), false, reqVersion);
    }
    async function parseNextWithTimeout(bufferedOnly: boolean): Promise<ParseResult> {
      if (bufferedOnly) {
        return {
          kind: 'request',
          req: parser.parseBufferedNext(),
        };
      }
      const idleMs = opts.idleTimeoutMs ?? 0;
      const headersMs = opts.headersTimeoutMs ?? 0;
      const timeoutMs = nextSeq > 0 && idleMs > 0 ? idleMs : headersMs;
      if (timeoutMs <= 0) {
        return {
          kind: 'request',
          req: await parser.parseNext(),
        };
      }
      const timeoutKind = nextSeq > 0 && idleMs > 0 ? 'idle-timeout' : 'headers-timeout';
      const timer = loop.timeout(timeoutMs);
      const timeoutMarker = {};
      const parsePromise = parser.parseNext();
      parsePromise.catch(() => {});
      const result = await Promise.race([parsePromise, timer.then(() => timeoutMarker)]);
      timer.cancel();
      if (result === timeoutMarker) return { kind: timeoutKind };
      return {
        kind: 'request',
        req: result as Request,
      };
    }
    async function pumpReads() {
      if (readPumpActive || !shouldReadMore()) return;
      readPumpActive = true;
      try {
        let bufferedOnly = false;
        while (shouldReadMore()) {
          let parsed: ParseResult;
          try {
            parsed = await parseNextWithTimeout(bufferedOnly);
          } catch (e) {
            parserDone = true;
            break;
          }
          if (parsed.kind === 'idle-timeout') {
            parserDone = true;
            break;
          }
          if (parsed.kind === 'headers-timeout') {
            const seq = nextSeq++;
            stopAfterSeq = seq;
            parserDone = true;
            pending.set(seq, {
              kind: 'response',
              prepared: await makeCloseResponse(408, 'Request Timeout'),
              closeAfter: true,
            });
            notify();
            break;
          }
          const req = parsed.req;
          if (req === null) break;
          // h2c Upgrade: intercept at the protocol layer before calling the handler.
          if (opts.allowH2cUpgrade && h2Available && _isH2cUpgrade(req)) {
            const seq = nextSeq++;
            stopAfterSeq = seq;
            parserDone = true;
            const settingsPayload = _decodeBase64Url(req.headers.get('http2-settings') ?? '');
            pending.set(seq, {
              kind: 'upgrade',
              conn: new _H2cUpgradeTakeover(
                handler,
                opts,
                req,
                settingsPayload,
                req.method === 'HEAD',
              ),
            });
            notify();
            break;
          }
          const seq = nextSeq++;
          const expect = req.headers.get('expect');
          if (expect !== null) {
            if (expect.toLowerCase().trim() === '100-continue') {
              await writer.write(_100);
              await writer.flush();
            } else {
              stopAfterSeq = seq;
              parserDone = true;
              pending.set(seq, {
                kind: 'response',
                prepared: await makeCloseResponse(417, 'Expectation Failed', req.version),
                closeAfter: true,
              });
              notify();
              break;
            }
          }
          const otelActive =
            _topicRequestStart.hasSubscribers ||
            _topicRequestEnd.hasSubscribers ||
            _topicRequestError.hasSubscribers;
          const requestId = otelActive ? 'http-server-' + ++_serverRequestSeq : '';
          let keepAlive = _shouldKeepAlive(req.headers, req.version);
          if (!keepAlive && seq < stopAfterSeq) stopAfterSeq = seq;
          inFlight++;
          if (_topicRequestStart.hasSubscribers) {
            let route = '/';
            try {
              route = new URL(req.url).pathname;
            } catch (_) {}
            _topicRequestStart.publish(
              otelRuntimeEvent('http.server', 'request', 'start', {
                requestId,
                method: req.method,
                route,
                url: req.url,
                headers: Object.fromEntries(req.headers.entries()),
                timeUnixNano: Date.now() * 1e6,
              }),
            );
          }
          const _requestContext = otelActive ? consumeRequestContext(requestId) : null;
          if (req.hasBody) bodyDrainCount++;
          const _handleAsync = async () => {
            let res: Response | ConnectionTakeover;
            let handlerError: unknown = null;
            try {
              res = await handler(req);
            } catch (e) {
              res = new Response('Internal Server Error', { status: 500 });
              handlerError = e;
              if (_topicRequestError.hasSubscribers) {
                _topicRequestError.publish(
                  otelRuntimeEvent('http.server', 'request', 'error', {
                    requestId,
                    method: req.method,
                    route: (() => {
                      try {
                        return new URL(req.url).pathname;
                      } catch (_) {
                        return '/';
                      }
                    })(),
                    url: req.url,
                    error: e,
                    timeUnixNano: Date.now() * 1e6,
                  }),
                );
              }
            }
            if (isConnectionTakeover(res)) {
              if (seq < stopAfterSeq) stopAfterSeq = seq;
              parserDone = true;
              readPumpActive = false;
              pending.set(seq, {
                kind: 'upgrade',
                conn: res,
              });
              if (req.hasBody) bodyDrainCount--;
              inFlight--;
              notify();
              return;
            }
            let drainAfterQueue = false;
            if (handlerError !== null && req.hasBody && !req.bodyUsed) {
              drainAfterQueue = true;
            } else {
              try {
                await _drainBody(req);
              } catch (e) {
                keepAlive = false;
              }
              if (req.hasBody) {
                bodyDrainCount--;
                notify();
              }
            }
            try {
              if ((res.headers.get('connection') || '').toLowerCase().trim() === 'close') {
                keepAlive = false;
              }
              if (!keepAlive && seq < stopAfterSeq) stopAfterSeq = seq;
            } catch {
              keepAlive = false;
            }
            let prepared: PreparedResponse;
            try {
              prepared = await _prepareResponse(res, keepAlive, req.version);
              if (_topicRequestEnd.hasSubscribers) {
                _topicRequestEnd.publish(
                  otelRuntimeEvent('http.server', 'request', 'end', {
                    requestId,
                    method: req.method,
                    route: (() => {
                      try {
                        return new URL(req.url).pathname;
                      } catch (_) {
                        return '/';
                      }
                    })(),
                    url: req.url,
                    statusCode: res.status,
                    timeUnixNano: Date.now() * 1e6,
                  }),
                );
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
                _topicRequestError.publish(
                  otelRuntimeEvent('http.server', 'request', 'error', {
                    requestId,
                    method: req.method,
                    route: (() => {
                      try {
                        return new URL(req.url).pathname;
                      } catch (_) {
                        return '/';
                      }
                    })(),
                    url: req.url,
                    error: e,
                    timeUnixNano: Date.now() * 1e6,
                  }),
                );
              }
            }
            pending.set(seq, {
              kind: 'response',
              prepared,
              closeAfter: !keepAlive,
            });
            if (drainAfterQueue) {
              notify();
              try {
                await _drainBody(req);
              } catch {
                keepAlive = false;
                if (seq < stopAfterSeq) stopAfterSeq = seq;
                const current = pending.get(seq);
                if (current?.kind === 'response') current.closeAfter = true;
              }
              bodyDrainCount--;
              notify();
            }
            inFlight--;
            notify();
          };
          void (_requestContext
            ? runWithActiveContext(_requestContext, _handleAsync)
            : _handleAsync());
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
          if (entry.kind === 'upgrade') {
            try {
              await entry.conn._takeOver(reader, writer);
            } catch (err) {
              console.error('fino:serve WebSocket upgrade failed:', err);
            }
            return;
          }
          const batch: PreparedResponse[] = [];
          let closeAfter = false;
          batch.push(entry.prepared);
          closeAfter = entry.closeAfter;
          while (!closeAfter && pending.has(nextWriteSeq) && batch.length < maxConcurrent) {
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
        if (shouldStop()) break;
        await new Promise<void>((resolve) => {
          notifier = resolve;
          if (
            shouldStop() ||
            (!readPumpActive && shouldReadMore()) ||
            (!flushActive && hasReadyResponses())
          ) {
            notify();
          }
        });
      }
    } finally {
      await writer.close();
      await reader.close();
    }
  }
}
// ---------------------------------------------------------------------------
// H1ClientDriver
// ---------------------------------------------------------------------------
/**
 * HTTP/1.1 client protocol driver for one already-connected socket.
 *
 * It serialises a single `Request`, flushes it, and parses the matching
 * `Response` off the same reader/writer pair. Everything around a single
 * exchange — DNS, TCP/TLS connect, connection pooling, redirect following, and
 * retries — is the caller's responsibility. Because HTTP/1.1 has no
 * multiplexing, one instance handles exactly one in-flight request at a time
 * over a given connection.
 *
 * ```ts no_run
 * import { H1ClientDriver } from 'internal:net/http/h1';
 *
 * const driver = new H1ClientDriver();
 * const res = await driver.send(req, reader, writer, { signal: null });
 * console.log(res.status, await res.text());
 * ```
 */
export class H1ClientDriver implements ClientDriver {
  /**
   * Always `false`: HTTP/1.1 cannot interleave requests on one connection.
   *
   * Pooling layers read this to decide whether a connection may carry a second
   * request before the first response has been fully consumed. For this driver
   * it never can, so a connection must be serialised or returned to the pool
   * between requests.
   *
   * ```ts no_run
   * if (!driver.multiplexed) {
   *   // Serialise: only borrow this connection for one exchange at a time.
   * }
   * ```
   */
  readonly multiplexed = false;
  /**
   * Send one HTTP request and parse its response.
   *
   * The write, flush, and response-parse steps are each raced against
   * `opts.signal` when one is supplied, so an abort rejects the returned promise
   * with the signal's reason even if the peer is slow or unresponsive. On
   * success the reader and writer are left open so the caller can pool or reuse
   * the connection; on abort or parse failure the promise rejects and the caller
   * is responsible for discarding the socket.
   *
   * ```ts no_run
   * const controller = new AbortController();
   * const res = await driver.send(req, reader, writer, { signal: controller.signal });
   * const body = await res.text();
   * ```
   */
  async send(
    req: Request,
    reader: BytesReader,
    writer: BytesWriter,
    opts: ClientDriverOptions,
  ): Promise<Response> {
    const signal = opts.signal;
    await _raceAbort(signal, writer.pipe(serializeRequest(req)));
    await _raceAbort(signal, writer.flush());
    return _raceAbort(signal, parseResponse(reader, req.method));
  }
}
