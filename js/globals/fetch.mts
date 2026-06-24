/**
 * Fetch API global implementation.
 *
 * WHATWG Fetch Standard: https://fetch.spec.whatwg.org/
 *
 * Implements Fino's release-supported server-side Fetch baseline:
 *   - HTTP and HTTPS support over plain TCP and TLS
 *   - HTTP/2 reuse for HTTPS origins that negotiate `h2` through ALPN
 *   - Redirect following with configurable `redirect` mode
 *   - AbortSignal cancellation, including during response body streaming
 *   - Subresource integrity checks for buffered response bodies
 *   - Explicit `referrer` and `referrerPolicy` handling
 *   - Response decompression for gzip, deflate, and brotli when available
 *   - global Request/Response/Headers backed by `internal:net/http/wire`
 *
 *
 * ## Connection lifecycle
 *
 * HTTP/1 requests open a fresh TCP or TLS connection per hop and request
 * `Connection: close`. The connection is kept alive until the response body is
 * fully consumed (or the iterator is closed early), at which point the socket
 * is closed. 204/304 and other bodyless responses close the socket immediately
 * after parsing headers. HTTPS requests that negotiate HTTP/2 through ALPN can
 * reuse the resulting H2 session through the origin-keyed pool.
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
 * ## Browser policy non-parity
 *
 * `Authorization`, `Cookie`, and `Cookie2` are stripped when following a
 * redirect to a different origin. Otherwise this is a server-side transport
 * API, not a browser policy engine. `mode`, `credentials`, `cache`, and
 * `keepalive` are accepted as compatibility fields, but they do not enforce
 * CORS, create opaque `no-cors` responses, maintain a browser cookie jar, reuse
 * cached responses, extend upload lifetime after shutdown, or synthesize a
 * default browser referrer. Caller-provided `Cookie` and authorization headers
 * remain explicit request headers until a cross-origin redirect strips them.
 *
 *
 * ## Usage
 *
 * ```ts no_run
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
 */

import { lookup } from 'fino:net/dns';
import { Socket } from 'fino:net/socket';
import { TlsSocket } from 'fino:net/tls';
import { QuicEndpoint } from 'fino:net/quic';
import {
  Request,
  Response,
  Headers,
  buildWireResponse,
} from 'internal:net/http/wire';
import { H1ClientDriver } from 'internal:net/http/h1';
import { H2ConnectionPool, createPoolEntry } from '../internal/net/http/pool.mts';
import { h2Available } from '../internal/net/http/h2/bindings.mts';
import type { Address } from 'fino:net/socket';
import type { QuicAddress, QuicConnection } from 'fino:net/quic';
import { H3ClientSession } from '../internal/net/http/h3/client.mts';
import { h3Available } from '../internal/net/http/h3/bindings.mts';
import {
  brotliAvailable,
  createDecompressor,
} from 'fino:compress';
import { topic } from 'fino:context/topic';
import { otelRuntimeEvent, otelRuntimeTopic } from '../internal/opentelemetry/common.mts';
import * as openssl from '../internal/openssl.mts';
import { _resolveObjectURL } from './url.mts';
import { _getBlobBytes } from './blob.mts';
import { atob, encodeUtf8 } from './encoding.mts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 20;

/**
 *  HTTP status codes that the fetch spec treats as redirects. */
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
  priority?: 'high' | 'low' | 'auto';
  trailers?: Headers | (() => Headers | Promise<Headers>);
  tls?: {
    ca?: string;
    rejectUnauthorized?: boolean;
  };
  protocol?: 'auto' | 'http/1.1' | 'h2' | 'h3';
}

interface TraceRuntime {
  requestId?: string;
  hop?: number;
}

interface ClosableSocket {
  closed: boolean;
  close(): void;
}

type FetchProtocol = NonNullable<FetchInit['protocol']>;

const BLOCKED_FETCH_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53,
  69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117,
  119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514,
  515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989,
  990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

function _assertAllowedFetchPort(url: string): void {
  const parsed = new URL(url);
  if (parsed.port === '') return;
  const port = Number(parsed.port);
  if (BLOCKED_FETCH_PORTS.has(port)) {
    throw new TypeError(`fetch: URL port ${port} is blocked`);
  }
}

function _fetchBaseLocation(): string | undefined {
  const location = (globalThis as { location?: unknown }).location;
  if (location === undefined || location === null) return undefined;
  return String(location);
}

function _normalizeFetchUrl(input: string): string {
  try {
    new URL(input);
    return input;
  } catch (_) {
    const base = _fetchBaseLocation();
    try {
      if (base !== undefined) return new URL(input, base).href;
    } catch { /* fall through to standard invalid URL error */ }
    throw new TypeError(`Invalid URL: ${input}`);
  }
}

function _normalizeFetchMethod(method: string): string {
  if (/^(connect|trace|track)$/i.test(method)) {
    throw new TypeError(`fetch: method ${method} is forbidden`);
  }
  return /^(delete|get|head|options|post|put)$/i.test(method) ? method.toUpperCase() : method;
}

function _singleChunkBody(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        next() {
          if (sent) return Promise.resolve({ done: true, value: undefined });
          sent = true;
          return Promise.resolve({ done: false, value: bytes });
        },
      };
    },
  };
}

function _parseBlobRange(range: string, size: number): { start: number; end: number } {
  const match = /^bytes[ \t]*=[ \t]*(?:(\d+)[ \t]*-[ \t]*(\d*)|-[ \t]*(\d+))[ \t]*$/.exec(range);
  if (match === null) throw new TypeError('fetch: invalid blob URL Range header');

  if (match[3] !== undefined) {
    const suffixLength = Number(match[3]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0 || size === 0) {
      throw new TypeError('fetch: unsatisfiable blob URL Range header');
    }
    return {
      start: Math.max(size - suffixLength, 0),
      end: size - 1,
    };
  }

  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start >= size) {
    throw new TypeError('fetch: unsatisfiable blob URL Range header');
  }
  const end = match[2] === '' ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(end) || end < start) {
    throw new TypeError('fetch: invalid blob URL Range header');
  }
  return {
    start,
    end: Math.min(end, size - 1),
  };
}

function _fetchBlobURL(url: string, method: string, headers: Headers, capturedBlob: ReturnType<Request['_getBlobURLObject']> = null): Response {
  if (method !== 'GET') {
    throw new TypeError(`fetch: blob URL requests only support GET, got ${method}`);
  }
  const blob = capturedBlob ?? _resolveObjectURL(url);
  if (blob === null) {
    throw new TypeError(`fetch: failed to resolve blob URL '${url}'`);
  }
  const bytes = new Uint8Array(_getBlobBytes(blob));
  const responseHeaders = new Headers();
  responseHeaders.set('content-type', blob.type);
  const range = headers.get('range');
  if (range !== null) {
    const { start, end } = _parseBlobRange(range, bytes.byteLength);
    const body = bytes.slice(start, end + 1);
    responseHeaders.set('content-length', String(body.byteLength));
    responseHeaders.set('content-range', `bytes ${start}-${end}/${bytes.byteLength}`);
    return buildWireResponse({
      version: '',
      status: 206,
      statusText: '',
      headers: responseHeaders,
      body: _singleChunkBody(body),
      url,
      type: 'basic',
      redirected: false,
    });
  }
  return buildWireResponse({
    version: '',
    status: 200,
    statusText: '',
    headers: responseHeaders,
    body: _singleChunkBody(bytes),
    url,
    type: 'basic',
    redirected: false,
  });
}

function _percentDecodeDataBytes(input: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    if (ch === 0x25) {
      const hex = input.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    if (ch <= 0x7f) bytes.push(ch);
    else bytes.push(...encodeUtf8(input[i]!));
  }
  return new Uint8Array(bytes);
}

function _base64DataBytes(input: string): Uint8Array {
  const binary = atob(input.replace(/[\t\n\f\r ]+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function _fetchDataURL(url: string, method: string): Response {
  const comma = url.indexOf(',');
  if (comma < 0) throw new TypeError(`fetch: invalid data URL '${url}'`);
  const metadata = url.slice(5, comma);
  const data = url.slice(comma + 1);
  const parts = metadata.split(';');
  let mime = parts[0] || 'text/plain;charset=US-ASCII';
  let base64 = false;
  for (let i = 1; i < parts.length; i++) {
    if (parts[i]!.toLowerCase() === 'base64') base64 = true;
    else mime += ';' + parts[i];
  }
  const body = method === 'HEAD'
    ? new Uint8Array(0)
    : (base64 ? _base64DataBytes(data) : _percentDecodeDataBytes(data));
  return buildWireResponse({
    version: '',
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': mime }),
    body: _singleChunkBody(body),
    url,
    type: 'basic',
    redirected: false,
  });
}

interface AltSvcEntry {
  host: string;
  port: number;
  expiresAt: number;
}

interface H3Target {
  address: QuicAddress;
  serverName: string;
}

class H3PoolEntry {
  readonly #origin: string;
  readonly #target: AltSvcEntry;
  readonly #tls: FetchInit['tls'] | undefined;
  readonly #handshakeTimeoutMs: number | null;
  #endpoint: QuicEndpoint | null = null;
  #conn: QuicConnection | null = null;
  #session: H3ClientSession | null = null;
  #ready: Promise<H3ClientSession> | null = null;
  #closed = false;
  #stage = 'new';

  constructor(origin: string, target: AltSvcEntry, tls?: FetchInit['tls'], handshakeTimeoutMs: number | null = null) {
    this.#origin = origin;
    this.#target = target;
    this.#tls = tls;
    this.#handshakeTimeoutMs = handshakeTimeoutMs;
  }

  async session(): Promise<H3ClientSession> {
    if (this.#closed) throw new Error('H3 pool entry is closed');
    if (this.#session !== null) return this.#session;
    if (this.#ready !== null) return this.#ready;

    this.#ready = (async () => {
      this.#stage = 'resolve';
      const target = await _resolveH3Target(this.#target.host, this.#target.port);
      this.#stage = `connect ${target.address.ip}:${target.address.port}`;
      const endpoint = new QuicEndpoint({ alpnProtocols: ['h3'] });
      this.#endpoint = endpoint;
      try {
        const conn = await endpoint.connect({
          address: target.address,
          alpnProtocols: ['h3'],
          serverName: target.serverName,
          ...(this.#handshakeTimeoutMs !== null ? { connection: { handshakeTimeoutMs: this.#handshakeTimeoutMs } } : {}),
          ...(this.#tls?.ca !== undefined ? { ca: this.#tls.ca as any } : {}),
          ...(this.#tls?.rejectUnauthorized === false ? { verifyPeer: false } : {}),
        });
        this.#conn = conn;
        this.#stage = 'create h3 session';
        conn.addEventListener('close', () => {
          _h3Pool.delete(this.#origin);
          this.close();
        }, { once: true });
        this.#session = await H3ClientSession.create(conn);
        this.#stage = 'ready';
        return this.#session;
      } catch (error) {
        const closeInfo = this.#conn?.closeInfo;
        try { await endpoint.close(); } catch {}
        this.#endpoint = null;
        this.#ready = null;
        if (closeInfo !== null && closeInfo !== undefined && error instanceof Error && error.message === 'QUIC connection is closed') {
          throw new Error(`QUIC connection is closed (${closeInfo.type} ${closeInfo.errorCode}${closeInfo.reason ? `: ${closeInfo.reason}` : ''})`);
        }
        throw error;
      }
    })();

    return this.#ready;
  }

  closeInfo(): QuicConnection['closeInfo'] | null {
    return this.#conn?.closeInfo ?? null;
  }

  stage(): string {
    return this.#stage;
  }

  setStage(stage: string): void {
    this.#stage = stage;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#session?.close(); } catch (_) {}
    try { this.#conn?.close(); } catch (_) {}
    void this.#endpoint?.close();
    this.#session = null;
    this.#conn = null;
    this.#endpoint = null;
  }
}

const _altSvcCache = new Map<string, AltSvcEntry>();
const _h3Pool = new Map<string, H3PoolEntry>();
let _h3HandshakeTimeoutMsForTest: number | null = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _parseHttpUrl(url: string, context = 'fetch'): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`${context}: non-HTTP/S URL is not allowed: '${parsed.href}'`);
  }
  return parsed;
}

function _originKey(parsed: URL): string {
  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
  return `${parsed.protocol}//${parsed.hostname}:${port}`;
}

function _urlHostname(url: URL): string {
  const hostname = url.hostname;
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

async function _resolveH3Target(host: string, port: number): Promise<H3Target> {
  const hostname = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const result = await lookup(hostname, { family: hostname.includes(':') ? 6 : 4 } as any);
  return {
    address: {
      family: result.family === 6 ? 'ipv6' : 'ipv4',
      ip: result.address,
      port,
    },
    serverName: hostname,
  };
}

function _isReplayableForH3(body: FetchBody | null): boolean {
  return body === null ||
    typeof body === 'string' ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer;
}

function _parseAltSvcFieldValue(value: string, originUrl: URL): AltSvcEntry | 'clear' | null {
  if (value.trim().toLowerCase() === 'clear') return 'clear';

  for (const rawAlt of value.split(',')) {
    const parts = rawAlt.split(';').map(part => part.trim()).filter(Boolean);
    const first = parts[0];
    if (!first) continue;
    const eq = first.indexOf('=');
    if (eq < 0) continue;
    const protocol = first.slice(0, eq).trim().toLowerCase();
    if (protocol !== 'h3') continue;
    let authority = first.slice(eq + 1).trim();
    if (authority.startsWith('"') && authority.endsWith('"')) {
      authority = authority.slice(1, -1);
    }

    let ma = 86400;
    for (let i = 1; i < parts.length; i++) {
      const param = parts[i]!;
      const paramEq = param.indexOf('=');
      if (paramEq < 0) continue;
      const name = param.slice(0, paramEq).trim().toLowerCase();
      if (name !== 'ma') continue;
      const parsedMa = Number(param.slice(paramEq + 1).trim().replace(/^"|"$/g, ''));
      if (Number.isFinite(parsedMa) && parsedMa >= 0) ma = Math.floor(parsedMa);
    }
    if (ma === 0) return 'clear';

    let host = _urlHostname(originUrl);
    let port = originUrl.port ? Number(originUrl.port) : 443;
    if (authority.startsWith(':')) {
      const parsedPort = Number(authority.slice(1));
      if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) continue;
      port = parsedPort;
    } else {
      try {
        const parsed = new URL(`https://${authority}`);
        host = _urlHostname(parsed);
        port = parsed.port ? Number(parsed.port) : 443;
      } catch (_) {
        continue;
      }
    }
    return { host, port, expiresAt: Date.now() + ma * 1000 };
  }
  return null;
}

function _processAltSvc(url: string, response: Response): void {
  const parsed = _parseHttpUrl(url);
  if (parsed.protocol !== 'https:') return;
  const header = response.headers.get('alt-svc');
  if (header === null) return;
  const origin = _originKey(parsed);
  const parsedAltSvc = _parseAltSvcFieldValue(header, parsed);
  if (parsedAltSvc === 'clear') {
    _altSvcCache.delete(origin);
    _evictH3(origin);
  } else if (parsedAltSvc !== null) {
    _altSvcCache.set(origin, parsedAltSvc);
  }
}

function _getAltSvc(origin: string): AltSvcEntry | null {
  const entry = _altSvcCache.get(origin);
  if (entry === undefined) return null;
  if (entry.expiresAt <= Date.now()) {
    _altSvcCache.delete(origin);
    _evictH3(origin);
    return null;
  }
  return entry;
}

function _evictH3(origin: string): void {
  const entry = _h3Pool.get(origin);
  if (entry !== undefined) {
    _h3Pool.delete(origin);
    entry.close();
  }
}

async function _singleFetchH3(
  url: string,
  method: string,
  headers: Headers,
  body: FetchBody,
  tls: FetchInit['tls'] | undefined,
  target: AltSvcEntry,
  trailers?: Headers | (() => Headers | Promise<Headers>),
): Promise<Response> {
  const parsed = _parseHttpUrl(url);
  const origin = _originKey(parsed);
  let entry = _h3Pool.get(origin);
  if (entry === undefined) {
    entry = new H3PoolEntry(origin, target, tls, _h3HandshakeTimeoutMsForTest);
    _h3Pool.set(origin, entry);
  }
  try {
    const session = await entry.session();
    entry.setStage('request');
    const h3Headers: Array<[string, string]> = [[':authority', parsed.host]];
    headers.forEach((value, name) => {
      if (!name.startsWith(':')) h3Headers.push([name, value]);
    });
    const response = await session.request(url, {
      method,
      headers: h3Headers,
      body: body !== null ? body as any : undefined,
      trailers: trailers as any,
    } as any);
    return buildWireResponse({
      version: 'HTTP/3',
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: response.body as any,
      url,
      redirected: false,
      inTrailers: response.trailers,
    });
  } catch (error) {
    const closeInfo = entry.closeInfo();
    const stage = entry.stage();
    _evictH3(origin);
    if (closeInfo !== null && error instanceof Error && error.message === 'QUIC connection is closed') {
      throw new Error(`QUIC connection is closed during ${stage} (${closeInfo.type} ${closeInfo.errorCode}${closeInfo.reason ? `: ${closeInfo.reason}` : ''})`);
    }
    if (error instanceof Error && error.message === 'QUIC connection is closed') {
      throw new Error(`QUIC connection is closed during ${stage}`);
    }
    throw error;
  }
}

/**
 *  Close a socket if it is open. Idempotent. */
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
 * Mirrors the internal HTTP wire _bodyFraming helper without importing it.
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
  tls?: FetchInit['tls'],
  protocol: FetchProtocol = 'auto',
  trustedHeaders?: Record<string, string>,
): Promise<{ response: Response; sock: Socket | TlsSocket | null }> {
  const parsed   = _parseHttpUrl(url);
  const isHttps  = parsed.protocol === 'https:';
  const hostname = parsed.hostname;
  const portStr  = parsed.port;
  const port     = portStr ? parseInt(portStr, 10) : (isHttps ? 443 : 80);
  const isDefaultPort = (isHttps && port === 443) || (!isHttps && port === 80);
  const origin = _originKey(parsed);

  if (protocol === 'h3') {
    if (!isHttps) throw new TypeError('fetch: protocol h3 requires an HTTPS URL');
    if (!h3Available) throw new Error('fetch: protocol h3 requires libnghttp3');
    const target = _getAltSvc(origin) ?? { host: _urlHostname(parsed), port, expiresAt: Number.MAX_SAFE_INTEGER };
    const response = await _singleFetchH3(url, method, headers, body, tls, target, trailers);
    return { response, sock: null };
  }

  if (protocol === 'auto' && isHttps && h3Available && _isReplayableForH3(body)) {
    const target = _getAltSvc(origin);
    if (target !== null) {
      try {
        const response = await _singleFetchH3(url, method, headers, body, tls, target, trailers);
        return { response, sock: null };
      } catch (_) {
        _altSvcCache.delete(origin);
        _evictH3(origin);
      }
    }
  }

  // ---- H2 pool fast-path (HTTPS only) --------------------------------------

  if (protocol !== 'http/1.1' && isHttps && h2Available) {
    const poolEntry = _h2Pool.get(origin);
    if (poolEntry) {
      const outReq = new Request(url, {
        method,
        headers: new Headers(headers),
        body: body !== null ? body as any : undefined,
        trailers: trailers ?? undefined,
      } as any);
      _appendTrustedHeaders(outReq, trustedHeaders);
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
      const alpn = protocol === 'h2'
        ? ['h2']
        : protocol === 'http/1.1'
          ? ['http/1.1']
          : h2Available ? ['h2', 'http/1.1'] : undefined;
      const tlsConnectP = TlsSocket.connect(addr, {
        hostname,
        alpn,
        ca: tls?.ca,
        rejectUnauthorized: tls?.rejectUnauthorized,
      });
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
      const entry = createPoolEntry(reader, writer);
      _h2Pool.add(origin, entry);
      const outReq = new Request(url, {
        method,
        headers: new Headers(headers),
        body: body !== null ? body as any : undefined,
        trailers: trailers ?? undefined,
      } as any);
      _appendTrustedHeaders(outReq, trustedHeaders);
      const response = await entry.send(outReq);
      return { response, sock: null };
    }

    if (protocol === 'h2') {
      throw new Error('fetch: protocol h2 was requested but TLS ALPN did not negotiate h2');
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
    _appendTrustedHeaders(outReq, trustedHeaders);

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

function _appendTrustedHeaders(request: Request, headers?: Record<string, string>): void {
  if (headers === undefined) return;
  for (const [name, value] of Object.entries(headers)) {
    request._appendTrustedHeader(name, value);
  }
}

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
 * Follows the WHATWG Fetch API core flow with Fino Request, Response, and
 * Headers objects. Redirect mode defaults to "follow", up to 20 hops. GET and
 * HEAD requests reject when given a body. AbortSignal cancellation is checked
 * before the request starts, during network operations, and while reading the
 * response body.
 *
 * The returned Response may have a streamed body. If the body is not consumed
 * or closed, the underlying HTTP/1 socket can remain open until the runtime
 * tears it down. HTTPS requests may reuse an HTTP/2 session when ALPN
 * negotiates h2. Integrity checks buffer the full body before returning a
 * Response.
 *
 * Browser policy knobs are intentionally limited in this release: CORS,
 * credentials, cache, cookies, keepalive lifetime, and default referrer
 * behavior are not enforced by the runtime. `mode: "no-cors"` still returns a
 * normal response, `credentials` never creates an implicit cookie jar, `cache`
 * never reuses a prior response, and `keepalive` does not extend work beyond
 * normal runtime lifetime. Explicit `referrer` and `referrerPolicy` values are
 * converted to a `Referer` header when supported.
 *
 * ```typescript no_run
 * const response = await fetch('https://example.com/data.json', {
 *   headers: { accept: 'application/json' },
 *   signal: AbortSignal.timeout(5000),
 *   redirect: 'follow',
 * });
 * if (response.ok) {
 *   const payload = await response.json();
 *   console.log(payload);
 * }
 * ```
 *
 * @param {string|Request} input   URL string or Request object.
 * @param {object}         [init]  RequestInit options:
 *   method?, headers?, body?, signal?, redirect?
 * @returns {Promise<Response>} response with final URL and redirect metadata.
 */
export async function fetch(input: string | Request, init?: FetchInit): Promise<Response> {
  // ---- Normalize input -------------------------------------------------------

  let baseUrl: string;
  let baseMethod: string;
  let baseHeaders: Headers;
  let baseBody: FetchBody | null;
  let baseBlobUrlObject: ReturnType<Request['_getBlobURLObject']> = null;
  let computedReferer: string | null = null;

  if (input instanceof Request) {
    baseUrl     = input.url;
    baseMethod  = input.method;
    baseHeaders = new Headers(input.headers);
    baseBlobUrlObject = input._getBlobURLObject();
    // If input is a Request with an unread body, use it. But since the body
    // is a one-shot iterable, this only works once. If init.body overrides it,
    // use that instead.
    baseBody    = (init && init.body !== undefined) ? init.body
                : (input.hasBody ? input.body : null);
    if (init?.body === undefined && input.hasBody) input._markBodyUsed();
  } else {
    baseUrl     = _normalizeFetchUrl(String(input));
    baseMethod  = 'GET';
    baseHeaders = new Headers();
    baseBody    = null;
  }

  // Apply init overrides
  if (init) {
    if (init.method  !== undefined) baseMethod  = _normalizeFetchMethod(String(init.method));
    if (init.headers !== undefined) baseHeaders = new Headers(init.headers)._setGuard('request');
    if (init.body    !== undefined) baseBody    = init.body;
  }

  const signal   = (init && init.signal)   ? init.signal   : null;
  const redirect = (init && init.redirect) ? init.redirect : 'follow';
  const protocol = init?.protocol ?? 'auto';

  if (redirect !== 'follow' && redirect !== 'error' && redirect !== 'manual') {
    throw new TypeError(`fetch: invalid redirect mode '${redirect}'`);
  }
  if (init?.priority !== undefined && init.priority !== 'high' && init.priority !== 'low' && init.priority !== 'auto') {
    throw new TypeError(`fetch: invalid priority '${init.priority}'`);
  }
  if (protocol !== 'auto' && protocol !== 'http/1.1' && protocol !== 'h2' && protocol !== 'h3') {
    throw new TypeError(`fetch: invalid protocol '${protocol}'`);
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
        if (refValue !== null) computedReferer = refValue;
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

  if (new URL(baseUrl).protocol === 'data:') {
    return _fetchDataURL(baseUrl, currentMethod);
  }

  if (new URL(baseUrl).protocol === 'blob:') {
    return _fetchBlobURL(baseUrl, currentMethod, currentHeaders, baseBlobUrlObject);
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (hop === MAX_REDIRECTS) {
      throw new TypeError('fetch: too many redirects');
    }
    _assertAllowedFetchPort(currentUrl);

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
        currentUrl, currentMethod, currentHeaders, currentBody, signal, { requestId, hop }, currentTrailers, init?.tls, protocol,
        computedReferer === null ? undefined : { referer: computedReferer }
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
    _processAltSvc(currentUrl, response);

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

      // Strip origin-bound credentials on cross-origin redirects.
      if (newOrigin && currentOrigin && newOrigin !== currentOrigin) {
        nextHeaders.delete('authorization');
        nextHeaders.delete('cookie');
        nextHeaders.delete('cookie2');
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

Object.defineProperty(fetch, 'length', {
  value: 1,
  configurable: true,
});

/**
 * Return whether the internal global fetch HTTP/2 pool has a live entry.
 *
 * This hook exists for runtime tests that need to assert ALPN pooling behavior
 * without exposing pool state through a public `fino:*` API.
 *
 * @internal
 */
export function _fetchH2PoolHas(origin: string): boolean {
  return _h2Pool.has(origin);
}

/**
 * Gracefully close one internal global fetch HTTP/2 pool entry for tests.
 *
 * The entry remains in the pool map until normal liveness checks evict it, so
 * `_fetchH2PoolHas()` observes the same `goingAway` state used by production
 * acquisition.
 *
 * @internal
 */
export function _closeFetchH2PoolEntry(origin: string): boolean {
  const entry = _h2Pool.get(origin);
  if (entry === undefined) return false;
  entry.close();
  return true;
}

/**
 * Gracefully close one internal global fetch HTTP/2 pool entry for tests.
 *
 * @internal
 */
export function _closeFetchH2PoolEntryForTest(origin: string): boolean {
  return _closeFetchH2PoolEntry(origin);
}

/**
 * Close and clear all internal global fetch HTTP/2 pool entries.
 *
 * Use this only in tests to isolate origin-keyed pool state between cases.
 *
 * @internal
 */
export function _resetFetchH2Pool(): void {
  _h2Pool.closeAll();
}

/**
 * Return whether the internal global fetch HTTP/3 pool has a live entry.
 *
 * @internal
 */
export function _fetchH3PoolHas(origin: string): boolean {
  return _h3Pool.has(origin);
}

/**
 * Close and clear all internal global fetch HTTP/3 pool entries.
 *
 * @internal
 */
export function _resetFetchH3Pool(): void {
  for (const [, entry] of _h3Pool) entry.close();
  _h3Pool.clear();
}

/**
 * Override automatic fetch HTTP/3 handshake timeout for deterministic tests.
 *
 * Passing `null` restores the runtime default. Existing H3 pool entries keep
 * the timeout they were created with, so tests should reset the H3 pool after
 * changing this value.
 *
 * @internal
 */
export function _setFetchH3HandshakeTimeoutForTest(ms: number | null): void {
  if (ms !== null && (!Number.isFinite(ms) || ms < 1)) {
    throw new TypeError('fetch H3 handshake timeout must be null or a positive finite number');
  }
  _h3HandshakeTimeoutMsForTest = ms === null ? null : Math.floor(ms);
}

/**
 * Return whether the internal global fetch Alt-Svc cache has a valid entry.
 *
 * @internal
 */
export function _fetchAltSvcHas(origin: string): boolean {
  return _getAltSvc(origin) !== null;
}

/**
 * Clear the internal global fetch Alt-Svc cache and dependent H3 sessions.
 *
 * @internal
 */
export function _resetFetchAltSvc(): void {
  _altSvcCache.clear();
  _resetFetchH3Pool();
}
