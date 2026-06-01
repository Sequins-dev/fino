/**
 * fino:fetch — spec-compliant Fetch API implementation.
 *
 * Implements the WHATWG Fetch spec's core flow:
 *   - HTTP and HTTPS support (plain TCP and TLS)
 *   - Redirect following with configurable `redirect` mode
 *   - AbortSignal cancellation (including during body streaming)
 *   - Request/Response/Headers from fino:http
 *
 *
 * ## Connection lifecycle
 *
 * Each `fetch()` call opens a fresh TCP or TLS connection per hop. There is
 * no connection pooling. The connection is kept alive until the response body
 * is fully consumed (or the iterator is closed early), at which point the
 * socket is closed. 204/304 and other bodyless responses close the socket
 * immediately after parsing headers.
 *
 *
 * ## Redirect handling
 *
 * The `redirect` init option controls redirect behaviour:
 *   - `'follow'` (default) — follow up to 20 redirects
 *   - `'error'`            — throw TypeError on any redirect response
 *   - `'manual'`           — return the redirect response as-is
 *
 * Method changes on redirect:
 *   - 301, 302, 303: method → GET, body dropped
 *   - 307, 308:      method kept; body must be replayable (non-stream)
 *
 *
 * ## AbortSignal
 *
 * `signal` is raced against every async operation: DNS lookup, TCP connect,
 * TLS handshake, and response parsing. After `fetch()` returns, the wrapped
 * body iterator also checks `signal.aborted` on each `.next()` call so that
 * a long streaming response can be cancelled mid-stream.
 *
 *
 * ## Cross-origin redirect
 *
 * `Authorization` is stripped when following a redirect to a different origin.
 * Other sensitive headers (Cookie, Cookie2) are not currently stripped — this
 * is a server-side runtime where CORS is not enforced.
 *
 *
 * ## Usage
 *
 * ```ts
 *   const res = await fetch('https://example.com/data');
 *   const json = await res.json();
 *
 *   const res = await fetch(url, {
 *     method: 'POST',
 *     headers: { 'content-type': 'application/json' },
 *     body: JSON.stringify(data),
 *     signal: AbortSignal.timeout(5000),
 *     redirect: 'follow',
 *   });
 * ```
 *
 * @internal
 */

import { lookup } from 'fino:net/dns';
import { Socket } from 'fino:net/socket';
import { TlsSocket } from 'fino:net/tls';
import {
  Request,
  Response,
  Headers,
  buildWireResponse,
} from 'fino:net/http';
import { H1ClientDriver } from 'fino:net/http/h1';
import { H2ConnectionPool, createPoolEntry } from '../net/http/pool.mts';
import { h2Available } from '../net/http/h2/bindings.mts';
import type { Address } from 'fino:net/socket';
import {
  brotliAvailable,
  createDecompressor,
} from 'fino:compress';
import { topic } from 'fino:context/topic';
import { otelRuntimeEvent, otelRuntimeTopic } from '../opentelemetry/common.mts';
import * as openssl from '../openssl.mts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 20;

/** HTTP status codes that the fetch spec treats as redirects. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
let _fetchRequestSeq = 0;

type HeadersInput = Headers | string[][] | Record<string, string> | null | undefined;
type FetchBody = unknown;

interface MinimalAbortSignal {
  aborted: boolean;
  reason: unknown;
  addEventListener(type: string, fn: () => void, opts?: { once?: boolean }): void;
  removeEventListener(type: string, fn: () => void): void;
}

interface FetchInit {
  method?: string;
  headers?: HeadersInput;
  body?: FetchBody;
  signal?: MinimalAbortSignal | null;
  redirect?: 'follow' | 'error' | 'manual';
  integrity?: string;
  referrerPolicy?: 'no-referrer' | 'no-referrer-when-downgrade' | 'origin' | 'origin-when-cross-origin' | 'same-origin' | 'strict-origin' | 'strict-origin-when-cross-origin' | 'unsafe-url' | '';
  referrer?: string;
  mode?: 'cors' | 'no-cors' | 'same-origin' | 'navigate';
  credentials?: 'omit' | 'same-origin' | 'include';
  cache?: 'default' | 'no-store' | 'reload' | 'no-cache' | 'force-cache' | 'only-if-cached';
  keepalive?: boolean;
  trailers?: Headers | (() => Headers | Promise<Headers>);
}

interface TraceRuntime {
  requestId?: string;
  hop?: number;
}

interface ClosableSocket {
  closed: boolean;
  close(): void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Close a socket if it is open. Idempotent. */
function _closeSocket(sock: { closed: boolean; close(): void } | null | undefined): void {
  if (sock && !sock.closed) {
    try { sock.close(); } catch (_) {}
  }
}

/**
 * Race `promise` against an AbortSignal, if one is provided.
 * Removes the abort listener when the promise settles to avoid leaks.
 */
function _raceAbort<T>(signal: MinimalAbortSignal | null | undefined, promise: Promise<T>): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  const activeSignal = signal;
  return new Promise(function raceAbortExecutor(resolve, reject) {
    function onAbort() { reject(activeSignal.reason); }
    activeSignal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      function onFulfilled(v) { activeSignal.removeEventListener('abort', onAbort); resolve(v); },
      function onRejected(e) { activeSignal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/**
 * Wrap a body async iterable with socket cleanup on completion or error.
 * Also checks the AbortSignal on each `.next()` call, so long-running
 * streaming bodies respect cancellation.
 */
function _wrapBody(rawBody: AsyncIterable<Uint8Array>, sock: ClosableSocket, signal: MinimalAbortSignal | null | undefined): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      const iter = rawBody[Symbol.asyncIterator]();
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          if (signal?.aborted) {
            _closeSocket(sock);
            throw signal.reason;
          }
          try {
            // Race iter.next() against the abort signal so that mid-stream
            // cancellation interrupts a blocking network read immediately.
            const result = await _raceAbort(signal, iter.next());
            if (result.done) _closeSocket(sock);
            return result;
          } catch (e) {
            _closeSocket(sock);
            throw e;
          }
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          _closeSocket(sock);
          if (typeof iter.return === 'function') {
            try { await iter.return(); } catch (_) {}
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
}

/**
 * Determine whether the response is expected to have a body.
 * Mirrors _bodyFraming in fino:http but without access to internals.
 */
function _hasBody(status: number, method?: string): boolean {
  if (method && method.toUpperCase() === 'HEAD') return false;
  if (status >= 100 && status < 200) return false;
  if (status === 204 || status === 304) return false;
  return true;
}

/**
 * Execute a single HTTP request hop and return the raw parsed response
 * plus the open socket (and its reader/writer split).
 *
 * Caller is responsible for closing the socket on error paths.
 *
 * @param {string}   url      — absolute URL string
 * @param {string}   method   — HTTP method
 * @param {Headers}  headers  — request headers (Host will be auto-injected)
 * @param {any}      body     — request body (null for bodyless, raw init value otherwise)
 * @param {AbortSignal|null} signal
 * @returns {Promise<{ response: Response, sock: Socket, reader, writer }>}
 */
async function _singleFetch(
  url: string,
  method: string,
  headers: Headers,
  body: FetchBody,
  signal: MinimalAbortSignal | null,
  runtime: TraceRuntime = {},
  trailers?: Headers | (() => Headers | Promise<Headers>),
): Promise<{ response: Response; sock: Socket | TlsSocket | null }> {
  const parsed   = new URL(url);
  const isHttps  = parsed.protocol === 'https:';
  const hostname = parsed.hostname;
  const portStr  = parsed.port;
  const port     = portStr ? parseInt(portStr, 10) : (isHttps ? 443 : 80);
  const isDefaultPort = (isHttps && port === 443) || (!isHttps && port === 80);

  // ---- H2 pool fast-path (HTTPS only) --------------------------------------

  if (isHttps && h2Available) {
    const origin = `https://${hostname}:${port}`;
    const poolEntry = _h2Pool.get(origin);
    if (poolEntry) {
      const outReq = new Request(url, {
        method,
        headers: new Headers(headers),
        body: body !== null ? body as any : undefined,
        trailers: trailers ?? undefined,
      } as any);
      const response = await poolEntry.send(outReq);
      return { response, sock: null };
    }
  }

  // ---- DNS lookup ----------------------------------------------------------

  const lookupId = `dns-${runtime.requestId || 'fetch'}-${runtime.hop || 0}`;
  topic(otelRuntimeTopic('dns', 'lookup', 'start')).publish(otelRuntimeEvent('dns', 'lookup', 'start', {
    lookupId,
    requestId: runtime.requestId,
    hop: runtime.hop,
    hostname,
    timeUnixNano: Date.now() * 1_000_000,
  }));
  let lookupResult;
  try {
    lookupResult = await _raceAbort(signal, lookup(hostname));
  } catch (error) {
    topic(otelRuntimeTopic('dns', 'lookup', 'error')).publish(otelRuntimeEvent('dns', 'lookup', 'error', {
      lookupId,
      requestId: runtime.requestId,
      hop: runtime.hop,
      hostname,
      error,
      timeUnixNano: Date.now() * 1_000_000,
    }));
    throw error;
  }
  const { address, family } = lookupResult;
  topic(otelRuntimeTopic('dns', 'lookup', 'end')).publish(otelRuntimeEvent('dns', 'lookup', 'end', {
    lookupId,
    requestId: runtime.requestId,
    hop: runtime.hop,
    hostname,
    address,
    family,
    timeUnixNano: Date.now() * 1_000_000,
  }));
  const addr: Address = family === 6
    ? { family: 'ipv6', ip: address, port }
    : { family: 'ipv4', ip: address, port };

  // ---- TCP / TLS connect ---------------------------------------------------

  let sock: Socket | TlsSocket;
  const connectId = `socket-${runtime.requestId || 'fetch'}-${runtime.hop || 0}`;
  topic(otelRuntimeTopic('socket', 'connect', 'start')).publish(otelRuntimeEvent('socket', 'connect', 'start', {
    connectId,
    requestId: runtime.requestId,
    hop: runtime.hop,
    host: address,
    port,
    transport: 'tcp',
    timeUnixNano: Date.now() * 1_000_000,
  }));
  if (isHttps) {
    const handshakeId = `tls-${runtime.requestId || 'fetch'}-${runtime.hop || 0}`;
    topic(otelRuntimeTopic('tls', 'handshake', 'start')).publish(otelRuntimeEvent('tls', 'handshake', 'start', {
      handshakeId,
      requestId: runtime.requestId,
      hop: runtime.hop,
      hostname,
      port,
      timeUnixNano: Date.now() * 1_000_000,
    }));
    try {
      const alpn = h2Available ? ['h2', 'http/1.1'] : undefined;
      const tlsConnectP = TlsSocket.connect(addr, { hostname, alpn });
      // If abort fires before the connect resolves, the socket still resolves
      // later — close it immediately to prevent a fd leak.
      tlsConnectP.then(s => { if (signal?.aborted) s.close(); }, () => {});
      sock = await _raceAbort(signal, tlsConnectP);
      topic(otelRuntimeTopic('socket', 'connect', 'end')).publish(otelRuntimeEvent('socket', 'connect', 'end', {
        connectId,
        requestId: runtime.requestId,
        hop: runtime.hop,
        host: address,
        port,
        transport: 'tcp',
        timeUnixNano: Date.now() * 1_000_000,
      }));
      topic(otelRuntimeTopic('tls', 'handshake', 'end')).publish(otelRuntimeEvent('tls', 'handshake', 'end', {
        handshakeId,
        requestId: runtime.requestId,
        hop: runtime.hop,
        hostname,
        port,
        protocol: 'tls',
        timeUnixNano: Date.now() * 1_000_000,
      }));
    } catch (error) {
      topic(otelRuntimeTopic('socket', 'connect', 'error')).publish(otelRuntimeEvent('socket', 'connect', 'error', {
        connectId,
        requestId: runtime.requestId,
        hop: runtime.hop,
        host: address,
        port,
        transport: 'tcp',
        error,
        timeUnixNano: Date.now() * 1_000_000,
      }));
      topic(otelRuntimeTopic('tls', 'handshake', 'error')).publish(otelRuntimeEvent('tls', 'handshake', 'error', {
        handshakeId,
        requestId: runtime.requestId,
        hop: runtime.hop,
        hostname,
        port,
        error,
        timeUnixNano: Date.now() * 1_000_000,
      }));
      throw error;
    }
  } else {
    try {
      const tcpConnectP = Socket.connect(addr);
      tcpConnectP.then(s => { if (signal?.aborted) s.close(); }, () => {});
      sock = await _raceAbort(signal, tcpConnectP);
      topic(otelRuntimeTopic('socket', 'connect', 'end')).publish(otelRuntimeEvent('socket', 'connect', 'end', {
        connectId,
        requestId: runtime.requestId,
        hop: runtime.hop,
        host: address,
        port,
        transport: 'tcp',
        timeUnixNano: Date.now() * 1_000_000,
      }));
    } catch (error) {
      topic(otelRuntimeTopic('socket', 'connect', 'error')).publish(otelRuntimeEvent('socket', 'connect', 'error', {
        connectId,
        requestId: runtime.requestId,
        hop: runtime.hop,
        host: address,
        port,
        transport: 'tcp',
        error,
        timeUnixNano: Date.now() * 1_000_000,
      }));
      throw error;
    }
  }

  try {
    const [reader, writer] = sock.split();

    // ---- H2 via negotiated ALPN ----------------------------------------------

    if (isHttps && h2Available && (sock as TlsSocket).negotiatedProtocol === 'h2') {
      const origin = `https://${hostname}:${port}`;
      const entry = createPoolEntry(reader, writer);
      _h2Pool.add(origin, entry);
      const outReq = new Request(url, {
        method,
        headers: new Headers(headers),
        body: body !== null ? body as any : undefined,
        trailers: trailers ?? undefined,
      } as any);
      const response = await entry.send(outReq);
      return { response, sock: null };
    }

    // ---- Build request with auto-injected Host ----------------------------

    const reqHeaders = new Headers(headers);
    if (!reqHeaders.has('host')) {
      const hostHeader = isDefaultPort ? hostname : `${hostname}:${portStr}`;
      reqHeaders.set('host', hostHeader);
    }
    // No connection pooling — always request close after response.
    if (!reqHeaders.has('connection')) {
      reqHeaders.set('connection', 'close');
    }
    // Signal compression support to the server.
    if (!reqHeaders.has('accept-encoding')) {
      reqHeaders.set('accept-encoding',
        brotliAvailable ? 'gzip, deflate, br' : 'gzip, deflate');
    }

    // Build the Request for serialization. body may be null (for GET etc.)
    // or any value accepted by the Request constructor.
    const outReq = new Request(url, {
      method,
      headers: reqHeaders,
      body: body !== null ? body as any : undefined,
      trailers: trailers ?? undefined,
    } as any);

    // ---- Send + parse via H1 driver -----------------------------------------

    const response = await _h1Driver.send(outReq, reader, writer, { signal });
    return { response, sock };

  } catch (e) {
    _closeSocket(sock);
    throw e;
  }
}

const _h1Driver = new H1ClientDriver();
const _h2Pool = new H2ConnectionPool();

/**
 * Build the final Response object returned to the caller.
 * Wraps the body (if any) so that socket cleanup happens automatically when
 * the body is fully consumed or the iterator is closed early.
 *
 * For bodyless responses (204, 304, 1xx) the socket is closed immediately.
 */
function _buildFinalResponse(
  response: Response,
  sock: Socket | TlsSocket | null,
  url: string,
  redirected: boolean,
  signal: MinimalAbortSignal | null,
  method?: string,
): Response {
  const status     = response.status;
  const statusText = response.statusText;
  const headers    = response.headers;
  const version    = response.version;

  if (!_hasBody(status, method)) {
    // No body expected — close socket immediately.
    _closeSocket(sock);
    return buildWireResponse({
      version, status, statusText, headers,
      body: null,
      url, redirected,
    });
  }

  // Access the raw body (marks bodyUsed = true on the intermediate Response).
  const rawBody = response.body;
  if (rawBody === null) {
    // Server sent a body-eligible status but no body data; close immediately.
    _closeSocket(sock);
    return buildWireResponse({
      version, status, statusText, headers,
      body: null,
      url, redirected,
    });
  }

  // Auto-decompress Content-Encoding responses (gzip, deflate, br).
  // Use the async-iterable streaming API directly — rawBody is already an
  // async iterable so no TransformStream overhead is needed.
  const responseHeaders = new Headers(headers);
  const encoding = (responseHeaders.get('content-encoding') || '').trim().toLowerCase();
  let bodyIterable: AsyncIterable<Uint8Array> = rawBody as unknown as AsyncIterable<Uint8Array>;

  if (encoding && encoding !== 'identity') {
    let decompressor;
    if (encoding === 'gzip' || encoding === 'x-gzip') {
      decompressor = createDecompressor({ format: 'gzip' });
    } else if (encoding === 'deflate') {
      decompressor = createDecompressor({ format: 'deflate' });
    } else if (encoding === 'deflate-raw') {
      decompressor = createDecompressor({ format: 'deflate-raw' });
    } else if (encoding === 'br' && brotliAvailable) {
      decompressor = createDecompressor({ format: 'brotli' });
    }

    if (decompressor) {
      bodyIterable = decompressor.transform(rawBody as unknown as AsyncIterable<Uint8Array>);
      // Remove framing headers that no longer apply after decompression.
      responseHeaders.delete('content-encoding');
      responseHeaders.delete('content-length');
    }
  }

  const wrappedBody = _wrapBody(bodyIterable, sock, signal);
  return buildWireResponse({
    version, status, statusText, headers: responseHeaders,
    body: wrappedBody,
    url, redirected,
    inTrailers: response.trailers,
  });
}

/**
 * Collect all chunks of an async iterable body into a single Uint8Array.
 */
async function _collectBody(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    totalLen += chunk.byteLength;
  }
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Wrap a Uint8Array as a single-chunk async iterable (for buildWireResponse).
 */
function _bytesToIterable(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      let done = false;
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          if (done) return { done: true, value: undefined };
          done = true;
          return { done: false, value: bytes };
        },
      };
    },
  };
}

/**
 * Verify SRI integrity of a response body.
 * Supports sha256, sha384, sha512 hash algorithms.
 * Throws TypeError if the hash does not match.
 */
function _checkIntegrity(bytes: Uint8Array, integrity: string): void {
  if (!integrity || !openssl.cryptoAvailable) return;
  // Support space-separated list of tokens (take the first)
  const token = integrity.trim().split(/\s+/)[0]!;
  const dashIdx = token.indexOf('-');
  if (dashIdx < 0) return;
  const hashAlias = token.slice(0, dashIdx).toLowerCase();
  const expectedB64 = token.slice(dashIdx + 1);
  const algMap: Record<string, string> = { sha256: 'sha-256', sha384: 'sha-384', sha512: 'sha-512' };
  const alg = algMap[hashAlias];
  if (!alg) throw new TypeError(`integrity: unsupported hash algorithm "${hashAlias}"`);
  const actual = openssl.digest(alg, bytes);
  // base64-encode actual
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let actualB64 = '';
  for (let i = 0; i < actual.length; i += 3) {
    const b0 = actual[i]!; const b1 = actual[i + 1] ?? 0; const b2 = actual[i + 2] ?? 0;
    actualB64 += chars[b0 >> 2]! + chars[((b0 & 3) << 4) | (b1 >> 4)]!;
    actualB64 += i + 1 < actual.length ? chars[((b1 & 15) << 2) | (b2 >> 6)]! : '=';
    actualB64 += i + 2 < actual.length ? chars[b2 & 63]! : '=';
  }
  if (actualB64 !== expectedB64) {
    throw new TypeError(`integrity check failed: expected ${token}`);
  }
}

/**
 * Like _buildFinalResponse but additionally enforces SRI integrity when
 * `integrity` is a non-empty string. Collects the full body eagerly so the
 * hash can be verified before the Response is handed to the caller.
 *
 * For bodyless responses (204, 304, etc.) the check is skipped.
 */
async function _buildFinalResponseWithIntegrity(
  response: Response,
  sock: Socket | TlsSocket | null,
  url: string,
  redirected: boolean,
  signal: MinimalAbortSignal | null,
  method: string | undefined,
  integrity: string | undefined,
): Promise<Response> {
  const built = _buildFinalResponse(response, sock, url, redirected, signal, method);

  if (!integrity || !_hasBody(response.status, method)) {
    return built;
  }

  // Collect body for integrity verification.
  const rawBody = built.body;
  if (rawBody === null) return built;

  const bytes = await _collectBody(rawBody as unknown as AsyncIterable<Uint8Array>);
  _checkIntegrity(bytes, integrity);

  // Re-wrap bytes as a streaming response so the caller gets a normal Response.
  const finalHeaders = new Headers(built.headers);
  return buildWireResponse({
    version:    response.version,
    status:     built.status,
    statusText: built.statusText,
    headers:    finalHeaders,
    body:       _bytesToIterable(bytes),
    url,
    redirected,
    inTrailers: built.trailers,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a resource over HTTP or HTTPS.
 *
 * Follows the WHATWG Fetch API.
 *
 * @param {string|Request} input   — URL string or Request object
 * @param {object}         [init]  — RequestInit options:
 *   method?, headers?, body?, signal?, redirect?
 * @returns {Promise<Response>}
 */
export async function fetch(input: string | Request, init?: FetchInit): Promise<Response> {
  // ---- Normalize input -------------------------------------------------------

  let baseUrl: string;
  let baseMethod: string;
  let baseHeaders: Headers;
  let baseBody: FetchBody | null;

  if (input instanceof Request) {
    baseUrl     = input.url;
    baseMethod  = input.method;
    baseHeaders = new Headers(input.headers);
    // If input is a Request with an unread body, use it. But since the body
    // is a one-shot iterable, this only works once. If init.body overrides it,
    // use that instead.
    baseBody    = (init && init.body !== undefined) ? init.body
                : (input.hasBody ? input.body : null);
  } else {
    baseUrl     = String(input);
    baseMethod  = 'GET';
    baseHeaders = new Headers();
    baseBody    = null;
  }

  // Apply init overrides
  if (init) {
    if (init.method  !== undefined) baseMethod  = String(init.method).toUpperCase();
    if (init.headers !== undefined) baseHeaders = new Headers(init.headers);
    if (init.body    !== undefined) baseBody    = init.body;
  }

  const signal   = (init && init.signal)   ? init.signal   : null;
  const redirect = (init && init.redirect) ? init.redirect : 'follow';

  if (redirect !== 'follow' && redirect !== 'error' && redirect !== 'manual') {
    throw new TypeError(`fetch: invalid redirect mode '${redirect}'`);
  }

  // Per spec: GET and HEAD requests must not have a body
  if ((baseMethod === 'GET' || baseMethod === 'HEAD') && baseBody != null) {
    throw new TypeError('fetch: GET and HEAD requests cannot have a body');
  }

  // ---- Initial abort check ---------------------------------------------------

  if (signal?.aborted) throw signal.reason;

  // ---- Referrer policy (applied once, before redirect loop) -----------------

  if (init?.referrer !== 'no-referrer') {
    const policy = init?.referrerPolicy ?? 'strict-origin-when-cross-origin';
    const referrer = typeof init?.referrer === 'string' && init.referrer !== 'about:client'
      ? init.referrer : undefined;
    if (referrer && policy !== 'no-referrer') {
      try {
        const refUrl  = new URL(referrer);
        const reqUrl  = new URL(typeof input === 'string' ? input : (input as Request).url);
        const sameOrigin = refUrl.origin === reqUrl.origin;
        const isHttps    = reqUrl.protocol === 'https:';
        const refIsHttps = refUrl.protocol === 'https:';
        let refValue: string | null = null;
        if (policy === 'unsafe-url') {
          refValue = referrer;
        } else if (policy === 'origin') {
          refValue = refUrl.origin + '/';
        } else if (policy === 'origin-when-cross-origin') {
          refValue = sameOrigin ? referrer : refUrl.origin + '/';
        } else if (policy === 'same-origin') {
          if (sameOrigin) refValue = referrer;
        } else if (policy === 'strict-origin') {
          if (!isHttps || refIsHttps) refValue = refUrl.origin + '/';
        } else if (policy === 'no-referrer-when-downgrade' || policy === 'strict-origin-when-cross-origin') {
          if (!isHttps || refIsHttps) refValue = sameOrigin ? referrer : refUrl.origin + '/';
        }
        if (refValue !== null) baseHeaders.set('referer', refValue);
      } catch { /* invalid URL — skip referrer */ }
    }
  }

  // ---- Redirect loop ---------------------------------------------------------

  let currentUrl      = baseUrl;
  let currentMethod   = baseMethod;
  let currentHeaders  = baseHeaders;
  let currentBody     = baseBody;
  let currentTrailers = (init && init.trailers) ? init.trailers : undefined;
  let redirected      = false;
  let currentOrigin: string | null = null;
  const requestId = 'fetch-' + (++_fetchRequestSeq);
  try { currentOrigin = new URL(baseUrl).origin; } catch (_) {}

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (hop === MAX_REDIRECTS) {
      throw new TypeError('fetch: too many redirects');
    }

    topic(otelRuntimeTopic('fetch', 'request', 'start')).publish(otelRuntimeEvent('fetch', 'request', 'start', {
      requestId,
      hop,
      method: currentMethod,
      url: currentUrl,
      headers: currentHeaders,
      timeUnixNano: Date.now() * 1_000_000,
    }));

    let response: Response;
    let sock: Socket | TlsSocket | null;
    try {
      ({ response, sock } = await _singleFetch(
        currentUrl, currentMethod, currentHeaders, currentBody, signal, { requestId, hop }, currentTrailers
      ));
    } catch (error) {
      topic(otelRuntimeTopic('fetch', 'request', 'error')).publish(otelRuntimeEvent('fetch', 'request', 'error', {
        requestId,
        hop,
        method: currentMethod,
        url: currentUrl,
        error,
        timeUnixNano: Date.now() * 1_000_000,
      }));
      throw error;
    }

    const status = response.status;

    // ---- Redirect handling ---------------------------------------------------

    if (REDIRECT_STATUSES.has(status)) {
      if (redirect === 'manual') {
        // Per spec: return an opaque redirect response (status 0, empty headers, null body).
        _closeSocket(sock);
        topic(otelRuntimeTopic('fetch', 'request', 'end')).publish(otelRuntimeEvent('fetch', 'request', 'end', {
          requestId,
          hop,
          method: currentMethod,
          url: currentUrl,
          statusCode: 0,
          timeUnixNano: Date.now() * 1_000_000,
        }));
        return buildWireResponse({
          version: response.version,
          status: 0,
          statusText: '',
          headers: new Headers(),
          body: null,
          url: '',
          redirected: false,
        });
      }

      // redirect === 'error'
      if (redirect === 'error') {
        _closeSocket(sock);
        topic(otelRuntimeTopic('fetch', 'request', 'error')).publish(otelRuntimeEvent('fetch', 'request', 'error', {
          requestId,
          hop,
          method: currentMethod,
          url: currentUrl,
          error: new TypeError(`fetch: redirect response with status ${status}`),
          statusCode: status,
          timeUnixNano: Date.now() * 1_000_000,
        }));
        throw new TypeError(`fetch: redirect response with status ${status}`);
      }

      // redirect === 'follow' — check Location before closing the socket so we
      // can return the response as-is if there is no Location header.
      const location = response.headers.get('location');
      if (!location) {
        // No Location header — treat as a normal (non-redirect) response.
        return _buildFinalResponseWithIntegrity(response, sock, currentUrl, redirected, signal, currentMethod, init?.integrity);
      }

      // Have a Location — consume/discard the redirect response body.
      _closeSocket(sock);

      // Resolve Location relative to current URL
      let resolvedUrl: string;
      try {
        resolvedUrl = new URL(location, currentUrl).href;
      } catch (_) {
        throw new TypeError(`fetch: invalid Location header: '${location}'`);
      }
      // Validate that the redirect target uses http: or https: — silently
      // following javascript:, file:, data:, or other schemes is a security risk.
      const redirectProtocol = new URL(resolvedUrl).protocol;
      if (redirectProtocol !== 'http:' && redirectProtocol !== 'https:') {
        throw new TypeError(
          `fetch: redirect to non-HTTP/S URL is not allowed: '${resolvedUrl}'`,
        );
      }

      // Compute new origin for cross-origin header stripping
      let newOrigin: string | null = null;
      try { newOrigin = new URL(resolvedUrl).origin; } catch (_) {}

      const nextHeaders = new Headers(currentHeaders);

      // Strip Authorization on cross-origin redirects
      if (newOrigin && currentOrigin && newOrigin !== currentOrigin) {
        nextHeaders.delete('authorization');
      }

      // 301, 302, 303 → GET + drop body
      if (status === 301 || status === 302 || status === 303) {
        currentMethod = 'GET';
        currentBody   = null;
        nextHeaders.delete('content-type');
        nextHeaders.delete('content-length');
        nextHeaders.delete('transfer-encoding');
      }
      // 307, 308 → keep method; body must still be replayable.
      // ReadableStream and async iterables are one-shot — throw rather than
      // silently sending an empty body on the redirected request.
      if ((status === 307 || status === 308) && currentBody !== null) {
        const b = currentBody as any;
        if (typeof b[Symbol.asyncIterator] === 'function' ||
            (typeof ReadableStream !== 'undefined' && b instanceof ReadableStream)) {
          throw new TypeError(
            'fetch: cannot follow 307/308 redirect with a streaming (non-replayable) request body',
          );
        }
      }
      // (currentBody is the raw init value — string/Uint8Array/Blob are replayable)

      currentUrl     = resolvedUrl;
      currentHeaders = nextHeaders;
      currentOrigin  = newOrigin;
      redirected     = true;
      continue;
    }

    // ---- Final response --------------------------------------------------------
    topic(otelRuntimeTopic('fetch', 'request', 'end')).publish(otelRuntimeEvent('fetch', 'request', 'end', {
      requestId,
      hop,
      method: currentMethod,
      url: currentUrl,
      statusCode: status,
      timeUnixNano: Date.now() * 1_000_000,
    }));
    return _buildFinalResponseWithIntegrity(response, sock, currentUrl, redirected, signal, currentMethod, init?.integrity);
  }

  // Unreachable (the loop always returns or throws), but satisfies the linter.
  throw new TypeError('fetch: internal error');
}
