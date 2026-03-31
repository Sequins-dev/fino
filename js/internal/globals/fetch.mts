/**
 * boats:fetch — spec-compliant Fetch API implementation.
 *
 * Implements the WHATWG Fetch spec's core flow:
 *   - HTTP and HTTPS support (plain TCP and TLS)
 *   - Redirect following with configurable `redirect` mode
 *   - AbortSignal cancellation (including during body streaming)
 *   - Request/Response/Headers from boats:http
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
 */

import { lookup } from 'boats:net/dns';
import { Socket } from 'boats:net/socket';
import { TlsSocket } from 'boats:net/tls';
import {
  Request,
  Headers,
  parseResponse,
  serializeRequest,
  buildWireResponse,
} from 'boats:net/http';
import * as loop from 'boats:runtime/loop';
import {
  brotliAvailable,
  createGunzip,
  createInflate,
  createInflateRaw,
  createBrotliDecompress,
} from 'boats:util/compression';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 20;

/** HTTP status codes that the fetch spec treats as redirects. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
function _raceAbort<T>(signal: { aborted: boolean; reason: unknown; addEventListener(type: string, fn: () => void, opts?: { once?: boolean }): void; removeEventListener(type: string, fn: () => void): void } | null | undefined, promise: Promise<T>): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    function onAbort() { reject(signal.reason); }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/**
 * Wrap a body async iterable with socket cleanup on completion or error.
 * Also checks the AbortSignal on each `.next()` call, so long-running
 * streaming bodies respect cancellation.
 */
function _wrapBody(rawBody, sock, signal) {
  return {
    [Symbol.asyncIterator]() {
      const iter = rawBody[Symbol.asyncIterator]();
      return {
        async next() {
          if (signal?.aborted) {
            _closeSocket(sock);
            throw signal.reason;
          }
          try {
            const result = await iter.next();
            if (result.done) _closeSocket(sock);
            return result;
          } catch (e) {
            _closeSocket(sock);
            throw e;
          }
        },
        async return() {
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
 * Mirrors _bodyFraming in boats:http but without access to internals.
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
 * @param {object}   lp       — loop handle
 * @param {string}   url      — absolute URL string
 * @param {string}   method   — HTTP method
 * @param {Headers}  headers  — request headers (Host will be auto-injected)
 * @param {any}      body     — request body (null for bodyless, raw init value otherwise)
 * @param {AbortSignal|null} signal
 * @returns {Promise<{ response: Response, sock: Socket, reader, writer }>}
 */
async function _singleFetch(lp, url, method, headers, body, signal) {
  const parsed   = new URL(url);
  const isHttps  = parsed.protocol === 'https:';
  const hostname = parsed.hostname;
  const portStr  = parsed.port;
  const port     = portStr ? parseInt(portStr, 10) : (isHttps ? 443 : 80);
  const isDefaultPort = (isHttps && port === 443) || (!isHttps && port === 80);

  // ---- DNS lookup ----------------------------------------------------------

  const { address, family } = await _raceAbort(signal, lookup(lp, hostname));
  const addr = { family: family === 6 ? 'ipv6' : 'ipv4', ip: address, port };

  // ---- TCP / TLS connect ---------------------------------------------------

  let sock;
  if (isHttps) {
    sock = await _raceAbort(signal, TlsSocket.connect(lp, addr, { hostname }));
  } else {
    sock = await _raceAbort(signal, Socket.connect(lp, addr));
  }

  try {
    const [reader, writer] = sock.split();

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
      body: body !== null ? body : undefined,
    });

    // ---- Send request --------------------------------------------------------

    await _raceAbort(signal, writer.pipe(serializeRequest(outReq)));

    // ---- Parse response headers ----------------------------------------------

    const response = await _raceAbort(signal, parseResponse(reader));
    return { response, sock, reader, writer };

  } catch (e) {
    _closeSocket(sock);
    throw e;
  }
}

/**
 * Build the final Response object returned to the caller.
 * Wraps the body (if any) so that socket cleanup happens automatically when
 * the body is fully consumed or the iterator is closed early.
 *
 * For bodyless responses (204, 304, 1xx) the socket is closed immediately.
 */
function _buildFinalResponse(response, sock, url, redirected, signal, method?) {
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
  let bodyIterable = rawBody;

  if (encoding && encoding !== 'identity') {
    let decompressor;
    if (encoding === 'gzip' || encoding === 'x-gzip') {
      decompressor = createGunzip();
    } else if (encoding === 'deflate') {
      decompressor = createInflate();
    } else if (encoding === 'deflate-raw') {
      decompressor = createInflateRaw();
    } else if (encoding === 'br' && brotliAvailable) {
      decompressor = createBrotliDecompress();
    }

    if (decompressor) {
      bodyIterable = decompressor.transform(rawBody);
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
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a resource over HTTP or HTTPS.
 *
 * Follows the WHATWG Fetch API. Requires an active event loop — must be
 * called inside `loop.run()` / `loop.runWith()`, or from a user script where
 * the event loop is already running.
 *
 * @param {string|Request} input   — URL string or Request object
 * @param {object}         [init]  — RequestInit options:
 *   method?, headers?, body?, signal?, redirect?
 * @returns {Promise<Response>}
 */
export async function fetch(input: string | Request, init?: RequestInit): Promise<Response> {
  const lp = loop.current();
  if (!lp) throw new TypeError('fetch() requires an active event loop');

  // ---- Normalize input -------------------------------------------------------

  let baseUrl;
  let baseMethod;
  let baseHeaders;
  let baseBody;

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

  // ---- Redirect loop ---------------------------------------------------------

  let currentUrl     = baseUrl;
  let currentMethod  = baseMethod;
  let currentHeaders = baseHeaders;
  let currentBody    = baseBody;
  let redirected     = false;
  let currentOrigin  = null;
  try { currentOrigin = new URL(baseUrl).origin; } catch (_) {}

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (hop === MAX_REDIRECTS) {
      throw new TypeError('fetch: too many redirects');
    }

    const { response, sock } = await _singleFetch(
      lp, currentUrl, currentMethod, currentHeaders, currentBody, signal
    );

    const status = response.status;

    // ---- Redirect handling ---------------------------------------------------

    if (REDIRECT_STATUSES.has(status)) {
      if (redirect === 'manual') {
        // Per spec: return an opaque redirect response (status 0, empty headers, null body).
        _closeSocket(sock);
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
        throw new TypeError(`fetch: redirect response with status ${status}`);
      }

      // redirect === 'follow' — check Location before closing the socket so we
      // can return the response as-is if there is no Location header.
      const location = response.headers.get('location');
      if (!location) {
        // No Location header — treat as a normal (non-redirect) response.
        return _buildFinalResponse(response, sock, currentUrl, redirected, signal, currentMethod);
      }

      // Have a Location — consume/discard the redirect response body.
      _closeSocket(sock);

      // Resolve Location relative to current URL
      let resolvedUrl;
      try {
        resolvedUrl = new URL(location, currentUrl).href;
      } catch (_) {
        throw new TypeError(`fetch: invalid Location header: '${location}'`);
      }

      // Compute new origin for cross-origin header stripping
      let newOrigin = null;
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
      // 307, 308 → keep method; body must still be replayable
      // (currentBody is the raw init value, so string/Uint8Array can be re-used)

      currentUrl     = resolvedUrl;
      currentHeaders = nextHeaders;
      currentOrigin  = newOrigin;
      redirected     = true;
      continue;
    }

    // ---- Final response --------------------------------------------------------

    return _buildFinalResponse(response, sock, currentUrl, redirected, signal, currentMethod);
  }

  // Unreachable (the loop always returns or throws), but satisfies the linter.
  throw new TypeError('fetch: internal error');
}
