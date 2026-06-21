/**
 * internal:net/http/wire — incremental HTTP/1.1 parser and serializer.
 *
 * This module implements HTTP/1.1 parsing and serialization entirely in JS,
 * building on Fino's async iterator model. There are no native bindings; the
 * parser is a hand-rolled state machine over byte chunks from any async source.
 *
 * It exports the internal Fetch-compatible wire implementation:
 *   - `Headers`           — WHATWG-compatible header map
 *   - `Request`           — Fetch API-compatible request (with async body)
 *   - `Response`          — Fetch API-compatible response (with async body)
 *   - `parseRequest(src)` — parse an incoming HTTP request from a byte stream
 *   - `parseResponse(src)`— parse an incoming HTTP response from a byte stream
 *   - `serializeRequest(req)`  — async iterable of wire bytes for a request
 *   - `serializeResponse(res)` — async iterable of wire bytes for a response
 *
 *
 * ## Body streams
 *
 * Request and Response bodies are exposed as `ReadableStream | null`.
 * Constructors accept byte buffers, strings, `FormData`, async iterables, and
 * `ReadableStream` instances. The body helpers and serializers consume those
 * streams with async iteration while preserving Fetch-style `bodyUsed`
 * semantics. `formData()` parses `application/x-www-form-urlencoded` bodies
 * into `FormData`; constructed `FormData` bodies serialize as outbound
 * `multipart/form-data`. Parsing incoming multipart bodies is intentionally
 * outside this release baseline.
 *
 *
 * ## How parsing works: _createReader
 *
 * The parser is built on a shared `_createReader(source)` helper that wraps
 * any async iterable of byte chunks into a stateful buffered reader. This
 * reader provides two higher-level operations:
 *
 *   1. `readUntilDoubleCRLF()` — reads bytes until the `\r\n\r\n` header
 *      terminator is found. Uses a 4-state match counter to avoid scanning
 *      the accumulation buffer from scratch each time. Returns a Uint8Array
 *      containing everything up through the terminator.
 *
 *   2. `bodyIterator(contentLength | null)` — returns an async iterable that
 *      yields body data. If `contentLength` is a number, it yields exactly
 *      that many bytes. If null, it reads until the underlying source is
 *      exhausted (EOF body framing, used for HTTP responses without
 *      Content-Length).
 *
 *   3. `chunkedBodyIterator()` — reads HTTP chunked transfer-encoding. Each
 *      chunk starts with a hex size line (`<hex>\r\n`), followed by the chunk
 *      data, followed by `\r\n`. The sequence ends with `0\r\n\r\n`.
 *
 *
 * ## Body framing detection
 *
 * After parsing headers, `_bodyFraming(headers, isRequest, statusCode)` decides
 * how the body is delimited:
 *   - `{ type: 'fixed', length: N }` — `Content-Length` header present
 *   - `{ type: 'chunked' }`          — `Transfer-Encoding: chunked`
 *   - `{ type: 'eof' }`              — response with no framing (read to EOF)
 *   - `{ type: 'none' }`             — no body (HEAD/1xx/204/304/requests
 *                                      without Content-Length)
 *
 *
 * ## The INTERNAL sentinel
 *
 * `Request` and `Response` have two construction paths:
 *   1. **Spec-style**: `new Request(url, init)` / `new Response(body, init)`
 *      Constructs from user-supplied data. No wire parsing involved.
 *   2. **Wire-parse**: `new Request(INTERNAL, parsed)` / `new Response(INTERNAL, parsed)`
 *      Used internally by `parseRequest()` / `parseResponse()` to construct
 *      objects from parsed wire data (already-decoded method, headers, body
 *      iterator). The `INTERNAL` symbol prevents external code from accidentally
 *      using this path.
 *
 *
 * ## bodyUsed guard
 *
 * Once a body has been iterated (via `.body[Symbol.asyncIterator]()` or
 * any of `.text()` / `.json()` / `.bytes()`), `bodyUsed` is set to true
 * and any subsequent attempt to read the body throws `TypeError`. This mirrors
 * the Fetch spec's "disturbed" stream semantics.
 *
 *
 * ## Serialization and _concat
 *
 * `serializeResponse()` and `serializeRequest()` return async iterables that
 * yield the status/request line + headers as the first chunk, then the body
 * chunks. For requests with a body but no `Content-Length`, chunked encoding
 * is injected automatically.
 *
 * The `_concat(parts, totalLen, arena?)` helper merges slices into a single
 * buffer. When an `Arena` is provided, the result is a view into the arena's
 * backing buffer (zero allocation). The FFI `write(2)` call correctly handles
 * the non-zero `byteOffset` of arena views.
 *
 *
 * ## Contributing
 *
 * - The header size limit (`MAX_HEADER_SIZE = 64 KiB`) protects against
 *   clients that try to exhaust memory by sending unbounded headers.
 * - The `_bodyFraming` function encodes the HTTP/1.1 framing rules from
 *   RFC 7230 §3.3. If you need to support HEAD requests on the server side,
 *   you'll need to pass the request method into the response framing logic.
 * - `Headers` stores a flat `[name, value]` pair array internally. This is
 *   simple and spec-compliant, but O(n) for lookups. For typical HTTP headers
 *   (< 50 entries) this is fine; for exotic use cases, a Map could be used.
 *
 * @example
 * ```ts no_run
 * import { Request, Response, parseRequest, serializeResponse } from 'internal:net/http/wire';
 *
 * const request = new Request('https://example.test/', { method: 'POST', body: 'hello' });
 * const response = new Response(await request.text(), {
 *   status: 201,
 *   headers: { 'content-type': 'text/plain' },
 * });
 * for await (const chunk of serializeResponse(response)) {
 *   await writer.write(chunk);
 * }
 * ```
 *
 * @internal
 */

import { decodeUtf8, encodeUtf8 } from '../../internal/globals/encoding.mts';
import { ReadableStream } from '../../internal/globals/webstreams.mts';
import { Blob } from '../../internal/globals/blob.mts';
import { FormData, _createMultipartBoundary, _serializeFormData } from '../../internal/globals/formdata.mts';
import { URLSearchParams } from '../../internal/globals/url.mts';
import { Scanner } from '../../parsing/scanner.mts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type HeadersInit =
  | Headers
  | string[][]
  | Record<string, string>
  | null
  | undefined;

type BodyInit = string | Uint8Array | ArrayBuffer | FormData | null;

type OutTrailers = Headers | (() => Headers | Promise<Headers>);

interface RequestInit {
  method?:   string;
  headers?:  HeadersInit;
  body?:     BodyInit;
  trailers?: OutTrailers;
}

interface ResponseInit {
  status?:     number;
  statusText?: string;
  headers?:    HeadersInit;
  trailers?:   OutTrailers;
}

interface WireResponseInit {
  version?:     string;
  status?:      number;
  statusText?:  string;
  headers:      Headers;
  body:         AsyncIterable<Uint8Array> | null;
  url?:         string;
  redirected?:  boolean;
  outTrailers?: OutTrailers | null;
  inTrailers?:  Promise<Headers> | null;
}

type AsyncByteSource = AsyncIterable<Uint8Array | ArrayBuffer>;
type AsyncByteIterable = AsyncIterable<Uint8Array>;
type BodyFraming =
  | { type: 'fixed'; length: number }
  | { type: 'chunked' }
  | { type: 'eof' }
  | { type: 'none' };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CR = 0x0D; // '\r'
const LF = 0x0A; // '\n'
const SPACE = 0x20; // ' '

// Constant byte sequences used in framing — allocated once, never modified.
const CRLF_BYTES = new Uint8Array([CR, LF]);
const LAST_CHUNK_BYTES = new Uint8Array([0x30, CR, LF, CR, LF]); // "0\r\n\r\n"

// Maximum header section size (prevents malicious clients from sending
// unbounded headers).  64 KiB should be plenty.
const MAX_HEADER_SIZE = 64 * 1024;

function _makeTrailersDeferred(): { resolve: (h: Headers) => void; reject: (e: Error) => void; promise: Promise<Headers> } {
  let resolve!: (h: Headers) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<Headers>(function makeTrailersDeferredExecutor(res, rej) { resolve = res; reject = rej; });
  return { resolve, reject, promise };
}

function _contentTypeEssence(headers: Headers): string {
  return (headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

function _formDataFromUrlEncoded(body: string): FormData {
  const params = new URLSearchParams(body);
  const form = new FormData();
  for (const [name, value] of params) form.append(name, value);
  return form;
}

// ---------------------------------------------------------------------------
// Arena: per-connection bump allocator
// ---------------------------------------------------------------------------

/**
 * Bump allocator backed by a single ArrayBuffer.
 *
 * Each `alloc(n)` returns a `Uint8Array` view at the current cursor, advances
 * the cursor by `n`, and never allocates a new backing store. `reset()` sets
 * the cursor back to zero, logically freeing all previous allocations in O(1).
 *
 * Used to eliminate per-request allocations for response encoding. All bytes
 * written into arena views are consumed by `write(2)` before `reset()` is
 * called, so there is no aliasing hazard. If the arena is full, `alloc()`
 * falls back to a regular `new Uint8Array(n)` — no failure mode.
 *
 * The FFI layer correctly handles the non-zero `byteOffset` of arena views
 * when they are passed to `write(2)` as `buffer` arguments.
 *
 * ```ts no_run
 * const arena = new Arena(4096);
 * const bytes = arena.alloc(128);
 * arena.reset();
 * ```
 */
export class Arena {
  /**
   * Private property `#buf` used by `Arena`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #buf = undefined;
   *
   *   readInternalState() {
   *     return this.#buf;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #buf: ArrayBuffer;
  /**
   * Private property `#cursor` used by `Arena`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #cursor = undefined;
   *
   *   readInternalState() {
   *     return this.#cursor;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #cursor: number;

  /**
   * Create an arena with the requested backing-buffer size.
   *
   * ```ts no_run
   * const arena = new Arena(65536);
   * ```
   */
  constructor(size: number = 8192) {
    this.#buf = new ArrayBuffer(size);
    this.#cursor = 0;
  }

  /**
   * Allocate a `Uint8Array` view of `n` bytes.
   *
   * If the arena has insufficient remaining space, this returns a standalone
   * `Uint8Array` instead of throwing. Previously returned arena views are
   * invalidated logically by `reset()` but not zeroed.
   *
   * ```ts no_run
   * const header = arena.alloc(64);
   * ```
   */
  alloc(n: number): Uint8Array {
    if (this.#cursor + n > this.#buf.byteLength) {
      return new Uint8Array(n); // fallback if arena is full
    }
    const view = new Uint8Array(this.#buf, this.#cursor, n);
    this.#cursor += n;
    return view;
  }

  /**
   * Reset the allocation cursor to the beginning of the backing buffer.
   *
   * Call this only after all views allocated from the arena have been consumed.
   *
   * ```ts no_run
   * arena.reset();
   * ```
   */
  reset(): void {
    this.#cursor = 0;
  }
}

// ---------------------------------------------------------------------------
// Internal: buffered reader over an async iterable of chunks
// ---------------------------------------------------------------------------

/**
 * Wraps an async iterable of ArrayBuffer / Uint8Array chunks into a stateful
 * reader that supports:
 *   - readUntilDoubleCRLF()  — consumes bytes until "\r\n\r\n"
 *   - bodyIterator(contentLength | null)  — returns an async iterable
 *     that yields remaining body data (either fixed-length or until EOF).
 */
function _createReader(source: AsyncByteSource) {
  const iter = source[Symbol.asyncIterator]();
  let buf: Uint8Array | null = null;   // leftover bytes from the current chunk
  let offset = 0;   // read position within `buf`
  let done = false;  // upstream exhausted?

  function _findDoubleCRLF(bytes: Uint8Array, start: number = 0): number {
    for (let i = start; i + 3 < bytes.byteLength; i++) {
      if (bytes[i] === CR && bytes[i + 1] === LF && bytes[i + 2] === CR && bytes[i + 3] === LF) {
        return i + 4;
      }
    }
    return -1;
  }

  /** Pull the next chunk from the upstream iterator. */
  async function pull(): Promise<boolean> {
    if (done) return false;
    const result = await iter.next();
    if (result.done) { done = true; return false; }
    const v = result.value;
    buf = v instanceof Uint8Array ? v : new Uint8Array(v);
    offset = 0;
    return true;
  }

  /** Return currently buffered but un-consumed bytes (may be empty). */
  function remaining(): Uint8Array | null {
    if (buf === null || offset >= buf.byteLength) return null;
    return buf.subarray(offset);
  }

  /**
   * Read bytes until the header terminator "\r\n\r\n" is found.
   * Returns a single Uint8Array containing everything up to and including the
   * terminator.  Any bytes after the terminator are kept in the internal buffer
   * for subsequent body reads.
   */
  async function readUntilDoubleCRLF(): Promise<Uint8Array> {
    // Fast path: CRLFCRLF is entirely within the current chunk — no allocation.
    const rem = remaining();
    if (rem !== null && rem.byteLength > 3) {
      const headerEnd = _findDoubleCRLF(rem, 0);
      if (headerEnd >= 0) {
        offset += headerEnd; // advance past headers; leftover bytes stay in buf
        return rem.subarray(0, headerEnd);
      }
    }

    // Slow path: headers span chunk boundaries (rare for typical HTTP traffic).
    const parts: Uint8Array[] = [];
    let totalLen = 0;

    while (true) {
      const r = remaining();
      if (r !== null && r.byteLength > 0) {
        const prefixLen = totalLen;
        parts.push(r);
        totalLen += r.byteLength;
        buf = null;
        offset = 0;
        if (totalLen > MAX_HEADER_SIZE) {
          throw new Error('HTTP header section exceeds ' + MAX_HEADER_SIZE + ' bytes');
        }

        const joined = parts.length === 1 ? r : _concat(parts, totalLen);
        const headerEnd = _findDoubleCRLF(joined, Math.max(0, prefixLen - 3));
        if (headerEnd >= 0) {
          const consumedFromCurrent = headerEnd - prefixLen;
          buf = r;
          offset = consumedFromCurrent;
          return joined.subarray(0, headerEnd);
        }
      }

      if (!(await pull())) {
        throw new Error('Unexpected end of stream before header terminator');
      }
    }
  }

  function readUntilDoubleCRLFBuffered(): Uint8Array | null {
    const rem = remaining();
    if (rem === null) return null;
    const headerEnd = _findDoubleCRLF(rem);
    if (headerEnd < 0) return null;
    const start = offset;
    offset += headerEnd;
    return rem.subarray(0, headerEnd);
  }

  /**
   * Return an async iterable that yields body data chunks.
   *
   * @param {number|null} contentLength  Known length, or null for read-until-EOF.
   */
  function bodyIterator(contentLength: number | null): AsyncByteIterable {
    let bytesLeft = contentLength; // null ⇒ read until EOF

    const iterator: AsyncIterator<Uint8Array> & AsyncByteIterable = {
      [Symbol.asyncIterator]() { return iterator; },

      async next(): Promise<IteratorResult<Uint8Array>> {
        // Fixed-length body — stop when we've emitted enough bytes.
        if (bytesLeft !== null && bytesLeft <= 0) {
          return { done: true, value: undefined };
        }

        // Drain any leftover bytes from the header read first.
        const rem = remaining();
        if (rem !== null && rem.byteLength > 0) {
          if (bytesLeft !== null) {
            const take = Math.min(rem.byteLength, bytesLeft);
            const slice = rem.subarray(0, take);
            bytesLeft -= take;
            if (take === rem.byteLength) {
              buf = null;
              offset = 0;
            } else {
              buf = rem;
              offset = take;
            }
            return { done: false, value: slice };
          }
          buf = null;
          offset = 0;
          return { done: false, value: rem };
        }

        // Pull from upstream.
        if (!(await pull())) {
          return { done: true, value: undefined };
        }
        const current = buf;
        if (current === null) {
          return { done: true, value: undefined };
        }
        const chunk = current.subarray(offset);

        if (bytesLeft !== null) {
          const take = Math.min(chunk.byteLength, bytesLeft);
          const slice = chunk.subarray(0, take);
          bytesLeft -= take;
          if (take === chunk.byteLength) {
            buf = null;
            offset = 0;
          } else {
            // More data than needed — keep the rest in buffer for the next
            // consumer (e.g. the next request header on keep-alive).
            offset += take;
          }
          return { done: false, value: slice };
        }
        buf = null;
        offset = 0;
        return { done: false, value: chunk };
      },
    };
    return iterator;
  }

  /**
   * Return an async iterable that decodes chunked transfer-encoding.
   *
   * Each HTTP chunk is: <hex-size>\r\n<data>\r\n
   * Terminated by a zero-length chunk: 0\r\n[trailer-headers]\r\n
   *
   * Optional callbacks: onTrailers is called with any parsed trailer headers
   * when the terminal chunk is reached. onError is called if iteration fails
   * before trailers are resolved, so callers can reject a trailer deferred.
   */
  function chunkedBodyIterator(
    onTrailers?: (h: Headers) => void,
    onError?: (e: Error) => void,
  ): AsyncByteIterable {
    let finished = false;

    // Internal byte-level helpers.
    async function ensureData(): Promise<void> {
      if (buf === null || offset >= buf.byteLength) {
        if (!(await pull())) throw new Error('Unexpected end of chunked stream');
      }
    }

    async function readByte(): Promise<number> {
      await ensureData();
      const current = buf;
      if (current === null) throw new Error('Unexpected end of chunked stream');
      return current[offset++] ?? 0;
    }

    // Read bytes until CRLF and return them as a Uint8Array (excluding CRLF).
    async function readLine(): Promise<Uint8Array> {
      const parts: Uint8Array[] = [];
      let total = 0;
      while (true) {
        await ensureData();
        const current = buf;
        if (current === null) throw new Error('Unexpected end of chunked stream');
        const start = offset;
        while (offset < current.byteLength) {
          if (current[offset] === CR) {
            // Peek for LF
            parts.push(current.subarray(start, offset));
            total += offset - start;
            offset++; // skip CR
            const lf = await readByte(); // should be LF
            if (lf !== LF) throw new Error('Expected LF after CR in chunk size line');
            return _concat(parts, total);
          }
          offset++;
        }
        parts.push(current.subarray(start, offset));
        total += offset - start;
      }
    }

    // Read exactly `n` bytes.
    async function readExact(n: number): Promise<Uint8Array> {
      if (n === 0) return new Uint8Array(0);
      const parts: Uint8Array[] = [];
      let remaining = n;
      while (remaining > 0) {
        await ensureData();
        const current = buf;
        if (current === null) throw new Error('Unexpected end of chunked stream');
        const avail = current.byteLength - offset;
        const take = Math.min(avail, remaining);
        parts.push(current.subarray(offset, offset + take));
        offset += take;
        remaining -= take;
      }
      const first = parts[0];
      return parts.length === 1 && first ? first : _concat(parts, n);
    }

    async function doNext(): Promise<IteratorResult<Uint8Array>> {
      if (finished) return { done: true, value: undefined };

      // Read the chunk-size line.
      const sizeLine = await readLine();
      const chunkSize = _parseChunkSizeLine(sizeLine);

      if (chunkSize === 0) {
        // Terminal chunk — parse optional trailer headers, then consume the
        // final CRLF. Trailers look like headers: "Name: value\r\n" lines
        // terminated by an empty "\r\n" line. Per RFC 9112 §7.1, the trailer
        // section must be consumed to keep the keep-alive pipeline in sync.
        const trailerHeaders = onTrailers ? new Headers() : null;
        while (true) {
          const trailerLine = await readLine();
          if (trailerLine.byteLength === 0) break;
          if (trailerHeaders !== null) {
            const { name, value } = _parseHeaderLine(decodeUtf8(trailerLine));
            trailerHeaders.append(name, value);
          }
        }
        finished = true;
        onTrailers?.(trailerHeaders ?? new Headers());
        return { done: true, value: undefined };
      }

      // Read the chunk data + trailing CRLF.
      const data = await readExact(chunkSize);
      const cr = await readByte();
      const lf = await readByte();
      if (cr !== CR || lf !== LF) {
        throw new Error('Expected CRLF after chunk data');
      }
      return { done: false, value: data };
    }

    const iterator: AsyncIterator<Uint8Array> & AsyncByteIterable = {
      [Symbol.asyncIterator]() { return iterator; },
      async next(): Promise<IteratorResult<Uint8Array>> {
        try {
          return await doNext();
        } catch (e) {
          onError?.(e instanceof Error ? e : new Error(String(e)));
          throw e;
        }
      },
    };
    return iterator;
  }

  return { readUntilDoubleCRLF, readUntilDoubleCRLFBuffered, bodyIterator, chunkedBodyIterator };
}

// ---------------------------------------------------------------------------
// Internal constructor sentinel + body helpers
// ---------------------------------------------------------------------------

/** Used to distinguish internal wire-parse construction from spec-style construction. */
const INTERNAL = Symbol('internal');

/** Wrap a Uint8Array as a single-chunk async iterable. */
/**
 * Internal function `_iterableFromBytes` used by `superset/worktrees/351077b5-cb94-454b-8784-50bc1f731bb7/sqlite/js/net/http`.
 *
 * This implementation detail is included when documentation is built with
 * `--include-private`. It describes state or helper behavior used by the
 * owning module rather than a stable application-facing contract. Prefer the
 * public API around the owning type unless you are maintaining this runtime.
 *
 * @example
 * ```ts no_run
 * const documentedMember = '_iterableFromBytes';
 * console.log(documentedMember);
 * ```
 *
 * @internal
 */
function _iterableFromBytes(bytes: Uint8Array): AsyncByteIterable {
  return {
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        next() {
          if (!sent) { sent = true; return Promise.resolve({ done: false, value: bytes }); }
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

/**
 * Convert a body init value to Uint8Array.
 * Accepts: string, ArrayBuffer, Uint8Array.
 */
function _toBytes(body: Exclude<BodyInit, null>): Uint8Array {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof body === 'string') return encodeUtf8(body);
  throw new TypeError('Body must be a string, ArrayBuffer, or Uint8Array');
}


// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/**
 * WHATWG-compatible Headers class.
 *
 * Internal storage is an array of [name, value] pairs with lowercased names.
 * Iteration order is sorted ascending by name (per spec).
 *
 * ```ts no_run
 * const headers = new Headers({ 'Content-Type': 'text/plain' });
 * headers.append('Set-Cookie', 'sid=1');
 * ```
 */
export class Headers {
  /**
   * Private property `#list` used by `Headers`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #list = undefined;
   *
   *   readInternalState() {
   *     return this.#list;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #list: [string, string][];
  /**
   * Private property `#sortedCache` used by `Headers`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #sortedCache = undefined;
   *
   *   readInternalState() {
   *     return this.#sortedCache;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #sortedCache: [string, string][] | null = null;

  /**
   * Create a header map from another `Headers`, pair array, object, or nothing.
   *
   * Header names are normalized to lowercase and values are trimmed. Invalid
   * pair entries throw `TypeError`.
   *
   * ```ts no_run
   * const headers = new Headers([['content-type', 'application/json']]);
   * ```
   */
  constructor(init?: HeadersInit) {
    this.#list = []; // [[name, value], ...]
    if (init == null) return;
    if (init instanceof Headers) {
      this.#list = init.#list.map(function copyHeaderPair(entry) { return [entry[0], entry[1]]; });
    } else if (Array.isArray(init)) {
      for (const pair of init) {
        if (pair.length < 2 || pair[0] === undefined || pair[1] === undefined) {
          throw new TypeError('Header pair must contain exactly two items');
        }
        this.append(pair[0], pair[1]);
      }
    } else if (typeof init === 'object') {
      for (const name of Object.keys(init)) {
        const value = init[name];
        if (value !== undefined) this.append(name, value);
      }
    }
  }

  /**
   * Append a new value for the given header name.
   * If the header already exists, the new value is added alongside the old.
   *
   * ```ts no_run
   * headers.append('set-cookie', 'a=1');
   * ```
   */
  append(name: string, value: string): void {
    name = _normalizeHeaderName(name);
    value = _normalizeHeaderValue(value);
    this.#list.push([name, value]);
    this.#sortedCache = null;
  }

  /**
   * Internal: append a pre-normalized [name, value] pair without validation.
   * name must already be lowercased and trimmed; value must already be trimmed
   * and free of control characters (guaranteed for wire-parsed headers).
   *
   * ```ts no_run
   * headers._appendTrusted('host', 'example.com');
   * ```
   */
  _appendTrusted(name: string, value: string): void {
    this.#list.push([name, value]);
    this.#sortedCache = null;
  }

  /**
   * Set the value for a header name, replacing any existing values.
   *
   * ```ts no_run
   * headers.set('content-type', 'application/json');
   * ```
   */
  set(name: string, value: string): void {
    name = _normalizeHeaderName(name);
    value = _normalizeHeaderValue(value);
    // Mutate in place: find the first occurrence and replace it, then remove
    // any duplicates. Avoids allocating a `next` array on every call.
    let firstIdx = -1;
    for (let i = 0; i < this.#list.length; i++) {
      const entry = this.#list[i]!;
      if (entry[0] === name) {
        if (firstIdx < 0) {
          entry[1] = value;
          firstIdx = i;
        } else {
          this.#list.splice(i, 1);
          i--;
        }
      }
    }
    if (firstIdx < 0) this.#list.push([name, value]);
    this.#sortedCache = null;
  }

  /**
   * Return the combined value for the given name, or null if not present.
   * Multiple values are joined with ", ".
   *
   * Use `getSetCookie()` for `Set-Cookie`, which must not be interpreted as a
   * comma-joined list.
   *
   * ```ts no_run
   * const contentType = headers.get('content-type') ?? 'application/octet-stream';
   * ```
   */
  get(name: string): string | null {
    name = name.toLowerCase().trim();
    // Avoid allocating an array for the common single-value case.
    let result: string | null = null;
    const list = this.#list;
    for (let i = 0; i < list.length; i++) {
      const entry = list[i]!;
      if (entry[0] === name) {
        result = result === null ? entry[1] : result + ', ' + entry[1];
      }
    }
    return result;
  }

  /** Return true if a header with the given name exists.
   *
   * ```ts no_run
   * if (headers.has('content-length')) console.log(headers.get('content-length'));
   * ```
   */
  has(name: string): boolean {
    name = name.toLowerCase().trim();
    for (const entry of this.#list) {
      if (entry[0] === name) return true;
    }
    return false;
  }

  /** Remove all values for the given header name.
   *
   * ```ts no_run
   * headers.delete('transfer-encoding');
   * ```
   */
  delete(name: string): void {
    name = name.toLowerCase().trim();
    this.#list = this.#list.filter(function keepNonMatching(entry) { return entry[0] !== name; });
    this.#sortedCache = null;
  }

  /**
   * Return an array of all Set-Cookie header values without joining.
   * Use this instead of get('set-cookie') to avoid value ambiguity.
   *
   * ```ts no_run
   * for (const cookie of headers.getSetCookie()) console.log(cookie);
   * ```
   */
  getSetCookie() {
    return this.#list
      .filter(function isSetCookie(entry) { return entry[0] === 'set-cookie'; })
      .map(function extractValue(entry) { return entry[1]; });
  }

  /** Return an iterator over [name, value] pairs, sorted by name.
   *
   * ```ts no_run
   * for (const [name, value] of headers.entries()) console.log(name, value);
   * ```
   */
  entries() {
    return this.#sorted()[Symbol.iterator]();
  }

  /** Return an iterator over header names, sorted.
   *
   * ```ts no_run
   * for (const name of headers.keys()) console.log(name);
   * ```
   */
  keys() {
    return this.#sorted().map(function extractName(e) { return e[0]; })[Symbol.iterator]();
  }

  /** Return an iterator over header values, sorted by name.
   *
   * ```ts no_run
   * for (const value of headers.values()) console.log(value);
   * ```
   */
  values() {
    return this.#sorted().map(function extractValue(e) { return e[1]; })[Symbol.iterator]();
  }

  /** Iterate over [name, value] pairs, sorted by name.
   *
   * ```ts no_run
   * headers.forEach((value, name) => console.log(name, value));
   * ```
   */
  forEach(callback: (value: string, name: string, headers: Headers) => void, thisArg?: unknown): void {
    for (const entry of this.#sorted()) {
      callback.call(thisArg, entry[1], entry[0], this);
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  /**
   * Private method `#sorted` used by `Headers`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #sorted() {
   *     return 'sorted';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#sorted();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #sorted(): [string, string][] {
    if (this.#sortedCache !== null) return this.#sortedCache;
    this.#sortedCache = this.#list.slice().sort(function compareHeaderNames(a, b) {
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    return this.#sortedCache;
  }
}

function _normalizeHeaderName(name: string): string {
  name = String(name).toLowerCase().trim();
  if (!name) throw new TypeError('Header name must not be empty');
  return name;
}

function _normalizeHeaderValue(value: string): string {
  value = String(value).trim();
  if (/[\x00\r\n]/.test(value)) throw new TypeError('Header value contains invalid characters');
  return value;
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/**
 * Parse a raw header block (everything up to and including "\r\n\r\n") into
 * a Headers instance.  Header names are lowercased; values are trimmed.
 *
 * Throws on obsolete folded header lines or malformed header syntax.
 *
 * ```ts no_run
 * const { firstLine, headers } = _parseHeaders(rawHeaderBytes);
 * ```
 */
export function _parseHeaders(raw: Uint8Array): { firstLine: string; headers: Headers } {
  const scanner = new Scanner(raw, { encoding: 'ascii', format: 'http' });
  const lines = scanner.readHeaderBlock();
  const firstLine = lines.shift() ?? '';
  const headers = new Headers();

  for (const line of lines) {
    const firstChar = line.charCodeAt(0);
    if (firstChar === SPACE || firstChar === 0x09) {
      throw new Error('Malformed header line: obsolete line folding is not supported');
    }
    const parsed = _parseHeaderLine(line);
    headers._appendTrusted(parsed.name, parsed.value);
  }

  return { firstLine, headers };
}

function _parseHeaderLine(line: string): { name: string; value: string } {
  const scanner = new Scanner(line, { encoding: 'ascii', format: 'http' });
  const name = scanner.readToken('header name').toLowerCase();
  if (!scanner.eatChar(':')) throw new Error('Malformed header line: missing colon');
  scanner.skipSpaceTab();
  const valueStart = scanner.mark();
  scanner.eatWhile(() => true);
  let value = scanner.text(valueStart);
  value = _trimAscii(value);
  return { name, value };
}

function _trimAscii(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end) {
    const c = value.charCodeAt(start);
    if (c !== SPACE && c !== 0x09) break;
    start++;
  }
  while (end > start) {
    const c = value.charCodeAt(end - 1);
    if (c !== SPACE && c !== 0x09) break;
    end--;
  }
  return value.slice(start, end);
}

/** @internal Parse a comma-delimited HTTP header token list.
 *
 * Returns an empty array for `null` or an empty string. Whitespace around tokens
 * is handled by the shared HTTP scanner.
 *
 * ```ts no_run
 * const tokens = _headerTokenList(headers.get('connection'));
 * ```
 */
export function _headerTokenList(value: string | null): string[] {
  if (value === null || value === '') return [];
  const scanner = new Scanner(value, { encoding: 'ascii', format: 'http' });
  return scanner.readDelimitedList(',');
}

function _parseRequestLine(firstLine: string): { method: string; path: string; version: string } {
  const scanner = new Scanner(firstLine, { encoding: 'ascii', format: 'http' });
  const method = scanner.readToken('method').toUpperCase();
  scanner.expect(' ', 'expected space after request method');
  const path = scanner.eatUntil(c => c === SPACE);
  if (path === '') throw new Error('Malformed request line: missing request target');
  scanner.expect(' ', 'expected space after request target');
  const version = scanner.readToken('HTTP version');
  if (!scanner.done) throw new Error('Malformed request line: unexpected data after HTTP version');
  return { method, path, version };
}

function _urlFromRequestTarget(path: string, headers: Headers): string {
  const host = headers.get('host');
  // RFC 7230 §5.3.4: asterisk-form ('*') is used by OPTIONS and must not be
  // combined with a host to form a URL. Use a synthetic absolute URL so the
  // Request object is always parseable, but expose the raw target via pathname.
  if (path === '*') return host ? 'http://' + host + '/*' : 'http://unknown/*';
  return host ? 'http://' + host + path : path;
}

/** @internal Parse an HTTP response status line into version, status, and text.
 *
 * Throws when the line is missing required spaces or when the status is outside
 * the parser's accepted 100-999 range.
 *
 * ```ts no_run
 * const line = _parseResponseLine('HTTP/1.1 200 OK');
 * ```
 */
export function _parseResponseLine(firstLine: string): { version: string; status: number; statusText: string } {
  const scanner = new Scanner(firstLine, { encoding: 'ascii', format: 'http' });
  const version = scanner.readToken('HTTP version');
  scanner.expect(' ', 'expected space after HTTP version');
  const status = scanner.readStrictInt({ name: 'status', min: 100, max: 999 });
  let statusText = '';
  if (!scanner.done) {
    scanner.expect(' ', 'expected space after status code');
    const mark = scanner.mark();
    scanner.eatWhile(() => true);
    statusText = scanner.text(mark);
  }
  return { version, status, statusText };
}

/**
 * Determine the body framing from the parsed headers.
 *
 * Returns:
 *   { type: 'fixed', length: <number> }  — Content-Length present
 *   { type: 'chunked' }                  — Transfer-Encoding: chunked
 *   { type: 'eof' }                      — read until connection closes
 *   { type: 'none' }                     — no body expected
 */
function _bodyFraming(headers: Headers, isRequest: boolean, statusCode: number): BodyFraming {
  // Responses to HEAD, 1xx, 204, 304 have no body.
  if (!isRequest) {
    if (statusCode >= 100 && statusCode < 200) return { type: 'none' };
    if (statusCode === 204 || statusCode === 304) return { type: 'none' };
  }

  const te = headers.get('transfer-encoding');
  if (te) {
    const tokens = _headerTokenList(te).map(t => t.toLowerCase());
    const last = tokens[tokens.length - 1] ?? '';
    if (last === 'chunked') {
      // RFC 9112 §6.3.3: when chunked is present, Content-Length MUST be
      // removed to prevent request-smuggling via the two-field ambiguity.
      headers.delete('content-length');
      return { type: 'chunked' };
    }
    if (isRequest) {
      throw new Error(`Invalid Transfer-Encoding for request: "${te}"`);
    }
  }

  const cl = headers.get('content-length');
  if (cl !== null) {
    // headers.get() joins multiple values with ", " when duplicates exist.
    // RFC 7230 §3.3.2: conflicting Content-Length values are a framing error.
    const values = _headerTokenList(cl);
    if (values.length === 0) throw new Error('Invalid Content-Length: empty');
    let first: number | null = null;
    for (const value of values) {
      const scanner = new Scanner(value, { encoding: 'ascii', format: 'http' });
      const length = scanner.readStrictInt({ name: 'Content-Length', min: 0 });
      if (!scanner.done) throw new Error(`Invalid Content-Length: "${value}"`);
      if (first === null) first = length;
      else if (length !== first) {
        throw new Error(`Conflicting Content-Length values: "${cl}"`);
      }
    }
    return { type: 'fixed', length: first ?? 0 };
  }

  // Requests with no Content-Length and no Transfer-Encoding have no body.
  if (isRequest) return { type: 'none' };

  // Responses without either header: read until EOF.
  return { type: 'eof' };
}

function _parseChunkSizeLine(lineBytes: Uint8Array): number {
  const scanner = new Scanner(lineBytes, { encoding: 'ascii', format: 'http' });
  let size: number;
  try {
    size = scanner.readStrictInt({ radix: 16, name: 'chunk size', min: 0 });
    scanner.skipSpaceTab();
  } catch (_) {
    throw new Error('Invalid chunk size: ' + decodeUtf8(lineBytes));
  }
  if (!scanner.done && scanner.peekCode() !== 0x3B) throw new Error('Invalid chunk size: ' + decodeUtf8(lineBytes));
  // Chunk extensions are intentionally ignored, but the size itself must be a
  // complete hexadecimal token rather than parseInt's permissive prefix parse.
  return size;
}

// Empty async iterable — used as the body sentinel for bodyless messages.
const _emptyBody = {
  [Symbol.asyncIterator]() {
    return { next() { return Promise.resolve({ done: true, value: undefined }); } };
  },
};

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Fetch API-compatible Request class.
 *
 * Spec-style constructor: new Request(url, init?)
 *   url  — URL string or another Request
 *   init — { method?, headers?, body? }
 *
 * Wire-parse constructor (internal): new Request(INTERNAL, { method, url, version, headers, body })
 *
 * ```ts no_run
 * const req = new Request('https://example.com/api', {
 *   method: 'POST',
 *   body: JSON.stringify({ ok: true }),
 * });
 * ```
 */
export class Request {
  /**
   * Private property `#bodyUsed` used by `Request`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #bodyUsed = undefined;
   *
   *   readInternalState() {
   *     return this.#bodyUsed;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #bodyUsed: boolean;
  /**
   * Private property `#method` used by `Request`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #method = undefined;
   *
   *   readInternalState() {
   *     return this.#method;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #method: string;
  /**
   * Private property `#url` used by `Request`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #url = undefined;
   *
   *   readInternalState() {
   *     return this.#url;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #url: string;
  /**
   * Private property `#version` used by `Request`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #version = undefined;
   *
   *   readInternalState() {
   *     return this.#version;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #version: string;
  /**
   * Private property `#headers` used by `Request`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #headers = undefined;
   *
   *   readInternalState() {
   *     return this.#headers;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #headers: Headers;
  /**
   * Private property `#rawBody` used by `Request`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #rawBody = undefined;
   *
   *   readInternalState() {
   *     return this.#rawBody;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #rawBody: AsyncIterable<Uint8Array> | null;
  /**
   * Private property `#bodyStream` used by `Request`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #bodyStream = undefined;
   *
   *   readInternalState() {
   *     return this.#bodyStream;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #bodyStream: ReadableStream | null = null;
  /**
   * Private property `#inTrailers` used by `Request`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #inTrailers = undefined;
   *
   *   readInternalState() {
   *     return this.#inTrailers;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #inTrailers: Promise<Headers> | null = null;
  /**
   * Private property `#outTrailers` used by `Request`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #outTrailers = undefined;
   *
   *   readInternalState() {
   *     return this.#outTrailers;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #outTrailers: OutTrailers | null = null;

  /**
   * Create a Request from a URL string, another Request, or the internal parser
   * sentinel.
   *
   * Body values may be strings, bytes, ArrayBuffers, FormData, async iterables,
   * ReadableStreams, or null. Reading the body later marks it used; cloning is
   * only allowed before disturbance.
   *
   * ```ts no_run
   * const req = new Request('/submit', { method: 'POST', body: 'hello' });
   * ```
   */
  constructor(input: string | Request | symbol, init?: RequestInit | any) {
    this.#bodyUsed = false;

    if (input === INTERNAL) {
      this.#method     = init.method;
      this.#url        = init.url;
      this.#version    = init.version;
      this.#headers    = init.headers;
      this.#rawBody    = init.body === _emptyBody ? null : init.body;
      this.#inTrailers = init.inTrailers ?? null;
      return;
    }

    // Spec-style construction.
    this.#url     = input instanceof Request ? input.#url : String(input);
    const rawMethod = (init && init.method) ? String(init.method) : 'GET';
    // Per Fetch spec, only these six methods are normalized to uppercase.
    this.#method  = /^(delete|get|head|options|post|put)$/i.test(rawMethod) ? rawMethod.toUpperCase() : rawMethod;
    this.#headers = (init && init.headers) ? new Headers(init.headers) : new Headers();
    this.#version = '';
    this.#outTrailers = (init && init.trailers != null) ? init.trailers : null;
    if (init && init.body != null) {
      if (init.body instanceof FormData) {
        const fd = init.body;
        const boundary = _createMultipartBoundary();
        if (!this.#headers.has('content-type')) {
          this.#headers.set('content-type', `multipart/form-data; boundary=${boundary}`);
        }
        this.#rawBody = { [Symbol.asyncIterator]: async function* formDataBodyGenerator() {
          const { body } = await _serializeFormData(fd, boundary);
          yield body;
        } };
      } else if (typeof (init.body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function' ||
                 (typeof ReadableStream !== 'undefined' && init.body instanceof ReadableStream)) {
        this.#rawBody = init.body as unknown as AsyncIterable<Uint8Array>;
      } else {
        this.#rawBody = _iterableFromBytes(_toBytes(init.body));
      }
    } else {
      this.#rawBody = null;
    }
  }

  /** Incoming trailer headers, resolving after a chunked body is fully consumed.
   *
   * For constructed outbound requests with trailer metadata, this resolves that
   * metadata immediately. Otherwise it resolves to an empty `Headers` object.
   *
   * ```ts no_run
   * const trailers = await req.trailers;
   * ```
   */
  get trailers(): Promise<Headers> {
    if (this.#inTrailers !== null) return this.#inTrailers;
    if (this.#outTrailers instanceof Headers) return Promise.resolve(this.#outTrailers);
    if (typeof this.#outTrailers === 'function') return Promise.resolve(this.#outTrailers() as Headers | Promise<Headers>);
    return Promise.resolve(new Headers());
  }

  /**
   * Internal method `_hasOutTrailers` used by `Request`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * const includePrivateExample = {
   *   _hasOutTrailers() {
   *     return '_hasOutTrailers';
   *   },
   * };
   * includePrivateExample._hasOutTrailers();
   * ```
   *
   * @internal
   */
  _hasOutTrailers(): boolean { return this.#outTrailers !== null; }

  /**
   * Internal method `_getRawOutTrailers` used by `Request`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * const includePrivateExample = {
   *   _getRawOutTrailers() {
   *     return '_getRawOutTrailers';
   *   },
   * };
   * includePrivateExample._getRawOutTrailers();
   * ```
   *
   * @internal
   */
  _getRawOutTrailers(): OutTrailers | null { return this.#outTrailers; }

  /** The full URL string.
   *
   * Parsed server requests are made absolute from `Host` when possible.
   *
   * ```ts no_run
   * console.log(req.url);
   * ```
   */
  get url() { return this.#url; }

  /** HTTP method.
   *
   * Common Fetch methods are normalized to uppercase during construction.
   *
   * ```ts no_run
   * if (req.method === 'POST') console.log('has body');
   * ```
   */
  get method() { return this.#method; }

  /** Mutable request headers.
   *
   * ```ts no_run
   * req.headers.set('authorization', 'Bearer token');
   * ```
   */
  get headers() { return this.#headers; }

  /**
   * The body as a ReadableStream, or null if no body.
   * Returns the same stream on repeated access (spec: [SameObject]).
   *
   * Accessing the stream does not consume it immediately, but locking or
   * reading it makes `bodyUsed` true.
   *
   * ```ts no_run
   * if (req.body !== null) for await (const chunk of req.body) console.log(chunk);
   * ```
   */
  get body(): ReadableStream | null {
    if (this.#rawBody === null) return null;
    return this.#bodyStream ??= ReadableStream.from(this.#rawBody);
  }

  /** True if the body has been read or the stream is locked.
   *
   * ```ts no_run
   * if (!req.bodyUsed) console.log(await req.text());
   * ```
   */
  get bodyUsed() {
    return this.#bodyUsed || (this.#bodyStream !== null && this.#bodyStream.locked);
  }

  /** HTTP version string, a Fino extension for parsed wire requests.
   *
   * Constructed requests use an empty string until serialized.
   *
   * ```ts no_run
   * console.log(req.version || 'not parsed from wire');
   * ```
   */
  get version() { return this.#version; }

  /** True if the request has a body.
   *
   * ```ts no_run
   * if (req.hasBody) await req.bytes();
   * ```
   */
  get hasBody() { return this.#rawBody !== null; }

  /**
   * Private method `#consumeBody` used by `Request`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #consumeBody() {
   *     return 'consumeBody';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#consumeBody();
   *   }
   * }
   * ```
   *
   * @internal
   */
  async #consumeBody() {
    if (this.#bodyUsed) throw new TypeError('body already consumed');
    if (this.#rawBody === null) return new Uint8Array(0);
    this.#bodyUsed = true;
    const source: AsyncIterable<Uint8Array> = this.#bodyStream ?? this.#rawBody;
    const parts = [];
    let total = 0;
    for await (const chunk of source) {
      parts.push(chunk);
      total += chunk.byteLength;
    }
    if (parts.length === 0) return new Uint8Array(0);
    return _concat(parts, total);
  }

  /** Consume body and return as a UTF-8 string.
   *
   * Throws `TypeError` if the body has already been consumed.
   *
   * ```ts no_run
   * const text = await req.text();
   * ```
   */
  async text() { return decodeUtf8(await this.#consumeBody()); }

  /** Consume body and parse as JSON.
   *
   * Throws `TypeError` if consumed already and propagates `JSON.parse` errors.
   *
   * ```ts no_run
   * const data = await req.json();
   * ```
   */
  async json() { return JSON.parse(await this.text()); }

  /** Consume body and return as a copied ArrayBuffer.
   *
   * ```ts no_run
   * const buffer = await req.arrayBuffer();
   * ```
   */
  async arrayBuffer() {
    const bytes = await this.#consumeBody();
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  }

  /** Consume body and return as Uint8Array.
   *
   * ```ts no_run
   * const bytes = await req.bytes();
   * ```
   */
  async bytes() { return this.#consumeBody(); }

  /** Consume body and return as a Blob.
   *
   * The Blob type is taken from the `content-type` header when present.
   *
   * ```ts no_run
   * const blob = await req.blob();
   * ```
   */
  async blob() {
    const buf = await this.arrayBuffer();
    const type = this.#headers.get('content-type') || '';
    return new Blob([buf], { type });
  }

  /** Consume an `application/x-www-form-urlencoded` body as FormData.
   *
   * Incoming multipart/form-data parsing is not implemented by this HTTP core;
   * constructed FormData bodies are still serialized as multipart for outbound
   * requests.
   *
   * ```ts no_run
   * const form = await req.formData();
   * ```
   */
  async formData() {
    const type = _contentTypeEssence(this.#headers);
    if (type === 'application/x-www-form-urlencoded') {
      return _formDataFromUrlEncoded(await this.text());
    }
    throw new TypeError(`formData(): unsupported content-type: ${type || '<none>'}`);
  }

  /** Create an independent copy of this request.
   *
   * Throws if the body has already been consumed or locked. Streaming bodies are
   * teed so both copies can be read independently.
   *
   * ```ts no_run
   * const clone = req.clone();
   * ```
   */
  clone(): Request {
    if (this.bodyUsed) throw new TypeError('Cannot clone a disturbed Request');
    if (this.#rawBody === null) {
      return new Request(INTERNAL, { method: this.#method, url: this.#url, version: this.#version, headers: new Headers(this.#headers), body: _emptyBody });
    }
    const stream = this.#bodyStream ?? ReadableStream.from(this.#rawBody);
    const [a, b] = stream.tee();
    this.#bodyStream = a;
    this.#rawBody = a as any;
    const cloned = new Request(INTERNAL, { method: this.#method, url: this.#url, version: this.#version, headers: new Headers(this.#headers), body: b });
    return cloned;
  }

  /**
   * Parse an HTTP/1.x request from an async iterable of byte chunks
   * (e.g. a TCP connection).
   *
   * Throws on malformed headers, invalid framing, or stream EOF before the
   * header terminator.
   *
   * ```ts no_run
   * const req = await Request.from(reader);
   * ```
   */
  static from(source: AsyncByteSource) { return parseRequest(source); }
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * Fetch API-compatible Response class.
 *
 * Spec-style constructor: new Response(body?, init?)
 *   body — string | ArrayBuffer | Uint8Array | null
 *   init — { status?, statusText?, headers? }
 *
 * Wire-parse constructor (internal): new Response(INTERNAL, { version, status, statusText, headers, body })
 *
 * Static factories: Response.json(), Response.redirect(), Response.error()
 *
 * ```ts no_run
 * const res = new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } });
 * ```
 */
export class Response {
  /**
   * Private property `#bodyUsed` used by `Response`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #bodyUsed = undefined;
   *
   *   readInternalState() {
   *     return this.#bodyUsed;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #bodyUsed: boolean;
  /**
   * Private property `#url` used by `Response`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #url = undefined;
   *
   *   readInternalState() {
   *     return this.#url;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #url: string;
  /**
   * Private property `#type` used by `Response`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #type = undefined;
   *
   *   readInternalState() {
   *     return this.#type;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #type: string;
  /**
   * Private property `#redirected` used by `Response`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #redirected = undefined;
   *
   *   readInternalState() {
   *     return this.#redirected;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #redirected: boolean;
  /**
   * Private property `#version` used by `Response`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #version = undefined;
   *
   *   readInternalState() {
   *     return this.#version;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #version: string;
  /**
   * Private property `#status` used by `Response`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #status = undefined;
   *
   *   readInternalState() {
   *     return this.#status;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #status: number;
  /**
   * Private property `#statusText` used by `Response`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #statusText = undefined;
   *
   *   readInternalState() {
   *     return this.#statusText;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #statusText: string;
  /**
   * Private property `#headers` used by `Response`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #headers = undefined;
   *
   *   readInternalState() {
   *     return this.#headers;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #headers: Headers;
  /**
   * Private property `#rawBody` used by `Response`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #rawBody = undefined;
   *
   *   readInternalState() {
   *     return this.#rawBody;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #rawBody: AsyncIterable<Uint8Array> | Uint8Array | null;
  /**
   * Private property `#bodyStream` used by `Response`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #bodyStream = undefined;
   *
   *   readInternalState() {
   *     return this.#bodyStream;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #bodyStream: ReadableStream | null = null;
  /**
   * Private property `#inTrailers` used by `Response`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #inTrailers = undefined;
   *
   *   readInternalState() {
   *     return this.#inTrailers;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #inTrailers: Promise<Headers> | null = null;
  /**
   * Private property `#outTrailers` used by `Response`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #outTrailers = undefined;
   *
   *   readInternalState() {
   *     return this.#outTrailers;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #outTrailers: OutTrailers | null = null;

  /**
   * Create a response from body data and optional status, headers, and trailers.
   *
   * Status defaults to 200 and statusText defaults to the empty string. Body
   * reads are single-use unless the response is cloned before consumption.
   *
   * ```ts no_run
   * const res = new Response(JSON.stringify({ ok: true }), { status: 201 });
   * ```
   */
  constructor(body: BodyInit | symbol, init?: ResponseInit | any) {
    this.#bodyUsed   = false;
    this.#url        = '';
    this.#type       = 'default';
    this.#redirected = false;

    if (body === INTERNAL) {
      this.#version     = init.version;
      this.#status      = init.status;
      this.#statusText  = init.statusText;
      this.#headers     = init.headers;
      this.#rawBody     = init.body === _emptyBody ? null : init.body;
      this.#outTrailers = init.outTrailers ?? null;
      this.#inTrailers  = init.inTrailers  ?? null;
      if (init.url !== undefined) this.#url = init.url;
      if (init.redirected !== undefined) this.#redirected = init.redirected;
      return;
    }

    // Spec-style construction.
    this.#version    = '';
    this.#status     = (init && init.status != null) ? Number(init.status) : 200;
    this.#statusText = (init && init.statusText != null) ? String(init.statusText) : '';
    this.#headers    = (init && init.headers) ? new Headers(init.headers) : new Headers();
    this.#outTrailers = (init && init.trailers != null) ? init.trailers : null;
    if (body != null) {
      if (body instanceof FormData) {
        const fd = body;
        const boundary = _createMultipartBoundary();
        if (!this.#headers.has('content-type')) {
          this.#headers.set('content-type', `multipart/form-data; boundary=${boundary}`);
        }
        this.#rawBody = { [Symbol.asyncIterator]: async function* formDataBodyGenerator() {
          const { body: bytes } = await _serializeFormData(fd, boundary);
          yield bytes;
        } };
      } else if (typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function' ||
                 (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream)) {
        // Accept async iterables and ReadableStreams as streaming bodies.
        this.#rawBody = body as unknown as AsyncIterable<Uint8Array>;
      } else {
        // Store bytes directly — avoids _iterableFromBytes wrapper allocation.
        // body getter wraps lazily in ReadableStream only when accessed.
        this.#rawBody = _toBytes(body as Exclude<BodyInit, null>);
      }
    } else {
      this.#rawBody = null;
    }
  }

  /** True if status is in the 200-299 range.
   *
   * ```ts no_run
   * if (res.ok) console.log(await res.text());
   * ```
   */
  get ok() { return this.#status >= 200 && this.#status < 300; }

  /** HTTP status code.
   *
   * ```ts no_run
   * console.log(res.status);
   * ```
   */
  get status() { return this.#status; }

  /** HTTP reason phrase.
   *
   * May be empty for constructed responses.
   *
   * ```ts no_run
   * console.log(res.statusText);
   * ```
   */
  get statusText() { return this.#statusText; }

  /** Mutable response headers.
   *
   * ```ts no_run
   * res.headers.set('content-type', 'application/json');
   * ```
   */
  get headers() { return this.#headers; }

  /**
   * The body as a ReadableStream, or null if no body.
   * Returns the same stream on repeated access (spec: [SameObject]).
   *
   * ```ts no_run
   * if (res.body !== null) for await (const chunk of res.body) console.log(chunk);
   * ```
   */
  get body(): ReadableStream | null {
    if (this.#rawBody === null) return null;
    const iterable = this.#rawBody instanceof Uint8Array
      ? _iterableFromBytes(this.#rawBody)
      : this.#rawBody;
    return this.#bodyStream ??= ReadableStream.from(iterable);
  }

  /** True if the body has been read or the stream is locked.
   *
   * ```ts no_run
   * if (!res.bodyUsed) console.log(await res.text());
   * ```
   */
  get bodyUsed() {
    return this.#bodyUsed || (this.#bodyStream !== null && this.#bodyStream.locked);
  }

  /** Final URL, empty for constructed responses and set by fetch clients.
   *
   * ```ts no_run
   * console.log(res.url);
   * ```
   */
  get url() { return this.#url; }

  /** Response type, currently `"default"` or `"error"`.
   *
   * ```ts no_run
   * if (res.type === 'error') console.log('network error response');
   * ```
   */
  get type() { return this.#type; }

  /** True if the response is the result of a redirect.
   *
   * ```ts no_run
   * console.log(res.redirected);
   * ```
   */
  get redirected() { return this.#redirected; }

  /** HTTP version string, a Fino extension for parsed wire responses.
   *
   * ```ts no_run
   * console.log(res.version || 'constructed response');
   * ```
   */
  get version() { return this.#version; }

  /** Incoming trailer headers, resolving after a chunked body is fully consumed.
   *
   * Constructed responses with outbound trailers resolve those trailers
   * immediately. Responses without trailers resolve an empty `Headers`.
   *
   * ```ts no_run
   * const trailers = await res.trailers;
   * ```
   */
  get trailers(): Promise<Headers> {
    if (this.#inTrailers !== null) return this.#inTrailers;
    if (this.#outTrailers instanceof Headers) return Promise.resolve(this.#outTrailers);
    if (typeof this.#outTrailers === 'function') return Promise.resolve((this.#outTrailers as () => Headers | Promise<Headers>)());
    return Promise.resolve(new Headers());
  }

  /**
   * Internal method `_hasOutTrailers` used by `Response`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * const includePrivateExample = {
   *   _hasOutTrailers() {
   *     return '_hasOutTrailers';
   *   },
   * };
   * includePrivateExample._hasOutTrailers();
   * ```
   *
   * @internal
   */
  _hasOutTrailers(): boolean { return this.#outTrailers !== null; }

  /**
   * Internal method `_getRawOutTrailers` used by `Response`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * const includePrivateExample = {
   *   _getRawOutTrailers() {
   *     return '_getRawOutTrailers';
   *   },
   * };
   * includePrivateExample._getRawOutTrailers();
   * ```
   *
   * @internal
   */
  _getRawOutTrailers(): OutTrailers | null { return this.#outTrailers; }

  /**
   * Internal method `_getOutTrailers` used by `Response`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * const includePrivateExample = {
   *   _getOutTrailers() {
   *     return '_getOutTrailers';
   *   },
   * };
   * includePrivateExample._getOutTrailers();
   * ```
   *
   * @internal
   */
  async _getOutTrailers(): Promise<Headers> {
    if (this.#outTrailers instanceof Headers) return this.#outTrailers;
    if (typeof this.#outTrailers === 'function') return (this.#outTrailers as () => Headers | Promise<Headers>)();
    return new Headers();
  }

  /**
   * @internal — serve.mts fast path: returns the raw Uint8Array if the body
   * is a pre-buffered byte payload, without allocating a ReadableStream wrapper.
   * Marks bodyUsed = true. Returns null when the body is null or a streaming
   * async iterable.
   *
   * @example
   * ```ts no_run
   * const includePrivateExample = {
   *   _extractBytes() {
   *     return '_extractBytes';
   *   },
   * };
   * includePrivateExample._extractBytes();
   * ```
   */
  _extractBytes(): Uint8Array | null {
    if (this.#rawBody instanceof Uint8Array) {
      this.#bodyUsed = true;
      return this.#rawBody;
    }
    return null;
  }

  /**
   * Private method `#consumeBody` used by `Response`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #consumeBody() {
   *     return 'consumeBody';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#consumeBody();
   *   }
   * }
   * ```
   *
   * @internal
   */
  async #consumeBody() {
    if (this.#bodyUsed) throw new TypeError('body already consumed');
    if (this.#rawBody === null) return new Uint8Array(0);
    this.#bodyUsed = true;
    // Fast path: avoid ReadableStream wrapping when body is already bytes.
    if (this.#rawBody instanceof Uint8Array) return this.#rawBody;
    const source: AsyncIterable<Uint8Array> = this.#bodyStream ?? this.#rawBody;
    const parts = [];
    let total = 0;
    for await (const chunk of source) {
      parts.push(chunk);
      total += chunk.byteLength;
    }
    if (parts.length === 0) return new Uint8Array(0);
    return _concat(parts, total);
  }

  /** Consume body and return as a UTF-8 string.
   *
   * ```ts no_run
   * const text = await res.text();
   * ```
   */
  async text() { return decodeUtf8(await this.#consumeBody()); }

  /** Consume body and parse as JSON.
   *
   * Throws if the body was already consumed or JSON parsing fails.
   *
   * ```ts no_run
   * const data = await res.json();
   * ```
   */
  async json() { return JSON.parse(await this.text()); }

  /** Consume body and return as a copied ArrayBuffer.
   *
   * ```ts no_run
   * const buffer = await res.arrayBuffer();
   * ```
   */
  async arrayBuffer() {
    const bytes = await this.#consumeBody();
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  }

  /** Consume body and return as Uint8Array.
   *
   * ```ts no_run
   * const bytes = await res.bytes();
   * ```
   */
  async bytes() { return this.#consumeBody(); }

  /** Consume body and return as a Blob.
   *
   * The Blob type is derived from `content-type` when present.
   *
   * ```ts no_run
   * const blob = await res.blob();
   * ```
   */
  async blob() {
    const buf = await this.arrayBuffer();
    const type = this.#headers.get('content-type') || '';
    return new Blob([buf], { type });
  }

  /** Consume an `application/x-www-form-urlencoded` body as FormData.
   *
   * Incoming multipart/form-data parsing is intentionally unsupported here.
   * Outbound `FormData` construction still serializes multipart bodies.
   *
   * ```ts no_run
   * const form = await res.formData();
   * ```
   */
  async formData() {
    const type = _contentTypeEssence(this.#headers);
    if (type === 'application/x-www-form-urlencoded') {
      return _formDataFromUrlEncoded(await this.text());
    }
    throw new TypeError(`formData(): unsupported content-type: ${type || '<none>'}`);
  }

  /** Create an independent copy of this response.
   *
   * Throws if the body is already consumed. Streaming bodies are teed; byte
   * bodies can be shared without copying.
   *
   * ```ts no_run
   * const copy = res.clone();
   * ```
   */
  clone(): Response {
    if (this.bodyUsed) throw new TypeError('Cannot clone a disturbed Response');
    if (this.#rawBody === null) {
      const cloned = new Response(INTERNAL, { version: this.#version, status: this.#status, statusText: this.#statusText, headers: new Headers(this.#headers), body: _emptyBody, url: this.#url, redirected: this.#redirected });
      cloned.#type = this.#type;
      return cloned;
    }
    // Uint8Array bodies are immutable — both copies can reference the same bytes.
    if (this.#rawBody instanceof Uint8Array) {
      const cloned = new Response(INTERNAL, { version: this.#version, status: this.#status, statusText: this.#statusText, headers: new Headers(this.#headers), body: this.#rawBody, url: this.#url, redirected: this.#redirected });
      cloned.#type = this.#type;
      return cloned;
    }
    const stream = this.#bodyStream ?? ReadableStream.from(this.#rawBody);
    const [a, b] = stream.tee();
    this.#bodyStream = a;
    this.#rawBody = a;
    const cloned = new Response(INTERNAL, { version: this.#version, status: this.#status, statusText: this.#statusText, headers: new Headers(this.#headers), body: b, url: this.#url, redirected: this.#redirected });
    cloned.#type = this.#type;
    return cloned;
  }

  /**
   * Create a Response with a JSON-serialised body and
   * Content-Type: application/json.
   *
   * ```ts no_run
   * return Response.json({ ok: true }, { status: 201 });
   * ```
   */
  static json(data: unknown, init?: ResponseInit) {
    const body = JSON.stringify(data);
    const headers = new Headers((init && init.headers) ? init.headers : {});
    headers.set('content-type', 'application/json');
    const status     = (init && init.status     != null) ? init.status     : 200;
    const statusText = (init && init.statusText != null) ? init.statusText : '';
    return new Response(body, { status, statusText, headers });
  }

  /**
   * Create a redirect Response.
   *
   * The status must be one of 301, 302, 303, 307, or 308, otherwise a
   * `RangeError` is thrown.
   *
   * ```ts no_run
   * return Response.redirect('/login', 302);
   * ```
   */
  static redirect(url: string, status?: number) {
    status = (status != null) ? Number(status) : 302;
    if (![301, 302, 303, 307, 308].includes(status)) {
      throw new RangeError(`Response.redirect: invalid redirect status ${status}`);
    }
    const headers = new Headers({ location: String(url) });
    return new Response(null, { status, headers });
  }

  /**
   * Create a network error Response (type "error", status 0).
   *
   * ```ts no_run
   * const res = Response.error();
   * console.log(res.type, res.status);
   * ```
   */
  static error() {
    const res = new Response(null, { status: 0, statusText: '' });
    res.#type = 'error';
    return res;
  }

  /**
   * Parse an HTTP/1.x response from an async iterable of byte chunks
   * (e.g. a TCP connection).
   *
   * ```ts no_run
   * const res = await Response.from(reader);
   * ```
   */
  static from(source: AsyncByteSource) { return parseResponse(source); }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse an HTTP/1.x request from an async iterable of byte chunks.
 *
 * The returned Request's `url` is constructed from the Host header and the
 * request path: "http://<host><path>".  If no Host header is present, `url`
 * contains only the path.
 *
 * Throws on malformed request lines, malformed headers, conflicting
 * `Content-Length`, invalid chunked framing, or premature EOF.
 *
 * ```ts no_run
 * const req = await parseRequest(reader);
 * ```
 */
export async function parseRequest(source: AsyncIterable<Uint8Array | ArrayBuffer>): Promise<Request> {
  const reader = _createReader(source);
  const raw = await reader.readUntilDoubleCRLF();
  const { firstLine, headers } = _parseHeaders(raw);

  const { method, path, version } = _parseRequestLine(firstLine);
  const url = _urlFromRequestTarget(path, headers);

  const framing = _bodyFraming(headers, true, 0);
  let body;
  let inTrailers: Promise<Headers> | null = null;
  if (framing.type === 'fixed') {
    body = reader.bodyIterator(framing.length);
  } else if (framing.type === 'chunked') {
    const deferred = _makeTrailersDeferred();
    inTrailers = deferred.promise;
    body = reader.chunkedBodyIterator(deferred.resolve, deferred.reject);
  } else {
    body = _emptyBody;
  }

  return new Request(INTERNAL, { method, url, version, headers, body, inTrailers });
}

/**
 * Parse an HTTP response from a byte stream.
 *
 * `method` is the original request method; pass `'HEAD'` so the parser knows
 * the response must not expose a body even if framing headers are present.
 * Throws on malformed status lines, headers, or body framing.
 *
 * ```ts no_run
 * const res = await parseResponse(reader, request.method);
 * ```
 */
export async function parseResponse(
  source: AsyncIterable<Uint8Array | ArrayBuffer>,
  method?: string,
): Promise<Response> {
  const reader = _createReader(source);
  const raw = await reader.readUntilDoubleCRLF();
  const { firstLine, headers } = _parseHeaders(raw);

  const { version, status, statusText } = _parseResponseLine(firstLine);

  // RFC 7230 §3.3: HEAD responses MUST NOT include a body even when
  // Content-Length or Transfer-Encoding is present.
  const isHead = method?.toUpperCase() === 'HEAD';
  const framing = isHead ? { type: 'none' as const } : _bodyFraming(headers, false, status);

  let body;
  let inTrailers: Promise<Headers> | null = null;
  if (framing.type === 'fixed') {
    body = reader.bodyIterator(framing.length);
  } else if (framing.type === 'chunked') {
    const deferred = _makeTrailersDeferred();
    inTrailers = deferred.promise;
    body = reader.chunkedBodyIterator(deferred.resolve, deferred.reject);
  } else if (framing.type === 'eof') {
    body = reader.bodyIterator(null);
  } else {
    body = _emptyBody;
  }

  return new Response(INTERNAL, { version, status, statusText, headers, body, inTrailers });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Concatenate an array of Uint8Array slices into a single Uint8Array.
 *
 * When an arena is supplied, the returned bytes may be a view into arena
 * storage. Callers must consume it before resetting the arena.
 *
 * ```ts no_run
 * const joined = _concat([a, b], a.byteLength + b.byteLength);
 * ```
 */
function _concat(parts: Uint8Array[], totalLen: number, arena?: Arena): Uint8Array {
  const first = parts[0];
  if (parts.length === 1 && first) return first;
  const result = arena ? arena.alloc(totalLen) : new Uint8Array(totalLen);
  let pos = 0;
  for (const p of parts) {
    result.set(p, pos);
    pos += p.byteLength;
  }
  return result;
}

/**
 * Encode an ASCII-only string into the given arena (or a fresh Uint8Array).
 * HTTP headers are always ASCII, so this avoids the 4x overalloc in encodeUtf8.
 */
function _encodeAscii(str: string, arena: Arena): Uint8Array {
  const buf = arena.alloc(str.length);
  for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i);
  return buf;
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/** Extract the path+query from a URL string (may be absolute or path-only). */
function _pathFromUrl(url: string): string {
  const schemeEnd = url.indexOf('://');
  if (schemeEnd !== -1) {
    const hostStart = schemeEnd + 3;
    const slashIdx  = url.indexOf('/', hostStart);
    return slashIdx >= 0 ? url.substring(slashIdx) : '/';
  }
  return url || '/';
}

/** Extract the host (with optional port) from an absolute URL, or null. */
function _hostFromUrl(url: string): string | null {
  const schemeEnd = url.indexOf('://');
  if (schemeEnd === -1) return null;
  const hostStart = schemeEnd + 3;
  const slashIdx  = url.indexOf('/', hostStart);
  return slashIdx >= 0 ? url.substring(hostStart, slashIdx) : url.substring(hostStart);
}

/** Serialize HTTP response headers to a string (status-line + headers + CRLF).
 *
 * Body bytes are not included. The version defaults to HTTP/1.1 when unset.
 *
 * ```ts no_run
 * const head = _buildResponseHead(new Response('ok'));
 * ```
 */
export function _buildResponseHead(res: Response): string {
  const version    = res.version || 'HTTP/1.1';
  const status     = res.status != null ? res.status : 200;
  const statusText = res.statusText != null ? res.statusText : '';
  let head = version + ' ' + status + (statusText ? ' ' + statusText : '') + '\r\n';
  for (const [name, value] of res.headers) {
    head += name + ': ' + value + '\r\n';
  }
  head += '\r\n';
  return head;
}

/**
 * Serialize HTTP request headers to a string (request-line + headers + CRLF).
 * @param {Request} req
 * @param {boolean} chunked  When true, injects Transfer-Encoding: chunked.
 */
function _buildRequestHead(req: Request, chunked: boolean): string {
  const method = req.method || 'GET';
  const path   = _pathFromUrl(req.url);
  let head = method + ' ' + path + ' HTTP/1.1\r\n';
  // Auto-inject Host header if derivable from URL and not already present.
  const host = _hostFromUrl(req.url);
  if (host && !req.headers.has('host')) {
    head += 'host: ' + host + '\r\n';
  }
  if (chunked) {
    head += 'transfer-encoding: chunked\r\n';
  }
  for (const [name, value] of req.headers) {
    head += name + ': ' + value + '\r\n';
  }
  head += '\r\n';
  return head;
}

/** Encode a single data chunk in HTTP chunked transfer-encoding format. */
function _chunkedFrame(bytes: Uint8Array, arena?: Arena): Uint8Array {
  const hex = bytes.byteLength.toString(16);
  const totalLen = hex.length + 2 + bytes.byteLength + 2; // hex + CRLF + data + CRLF
  const out = arena ? arena.alloc(totalLen) : new Uint8Array(totalLen);
  let pos = 0;
  for (let i = 0; i < hex.length; i++) out[pos++] = hex.charCodeAt(i);
  out[pos++] = CR;
  out[pos++] = LF;
  out.set(bytes, pos);
  pos += bytes.byteLength;
  out[pos++] = CR;
  out[pos++] = LF;
  return out;
}

/**
 * Serialize a Response to an async iterable of Uint8Array chunks suitable for
 * piping to a TCP connection: status-line + headers first, then body chunks.
 *
 * If outbound trailers are present, chunked transfer encoding is emitted and
 * `content-length` is removed from the wire headers. Reading from the returned
 * iterable consumes the response body.
 *
 * ```ts no_run
 * for await (const chunk of serializeResponse(res, new Arena())) {
 *   await writer.write(chunk);
 * }
 * ```
 */
export async function* serializeResponse(res: Response, arena?: Arena): AsyncGenerator<Uint8Array> {
  const hasOutTrailers = res._hasOutTrailers();
  const te = (res.headers.get('transfer-encoding') || '').toLowerCase();
  const alreadyChunked = _headerTokenList(te).map(t => t.toLowerCase()).includes('chunked');
  const isChunked = alreadyChunked || hasOutTrailers;

  // When out-trailers force chunked but TE header isn't set, emit a modified head.
  let headStr: string;
  if (hasOutTrailers && !alreadyChunked) {
    const wireHeaders = new Headers(res.headers);
    wireHeaders.delete('content-length');
    wireHeaders.set('transfer-encoding', 'chunked');
    const version    = res.version || 'HTTP/1.1';
    const status     = res.status != null ? res.status : 200;
    const statusText = res.statusText != null ? res.statusText : '';
    let head = version + ' ' + status + (statusText ? ' ' + statusText : '') + '\r\n';
    for (const [name, value] of wireHeaders) head += name + ': ' + value + '\r\n';
    headStr = head + '\r\n';
  } else {
    headStr = _buildResponseHead(res);
  }
  yield arena ? _encodeAscii(headStr, arena) : encodeUtf8(headStr);

  const body = res.body;
  if (body !== null) {
    for await (const chunk of body) {
      yield isChunked ? _chunkedFrame(chunk, arena) : chunk;
    }
  }

  if (isChunked) {
    if (hasOutTrailers) {
      const trailers = await res._getOutTrailers();
      let trailerBlock = '0\r\n';
      for (const [name, value] of trailers) trailerBlock += name + ': ' + value + '\r\n';
      trailerBlock += '\r\n';
      yield encodeUtf8(trailerBlock);
    } else {
      yield LAST_CHUNK_BYTES;
    }
  }
}

/**
 * Serialize a Request to an async iterable of Uint8Array chunks suitable for
 * piping to a TCP connection: request-line + headers first, then body chunks.
 *
 * Body framing:
 *   - No body → no framing headers added.
 *   - `content-length` already present → body emitted verbatim.
 *   - Body without content-length → `transfer-encoding: chunked` injected.
 *
 * Reading from the returned iterable consumes the request body.
 *
 * ```ts no_run
 * for await (const chunk of serializeRequest(req)) {
 *   await writer.write(chunk);
 * }
 * ```
 */
export async function* serializeRequest(req: Request): AsyncGenerator<Uint8Array> {
  const hasOutTrailers = req._hasOutTrailers();
  const chunked = hasOutTrailers || (req.hasBody && !req.headers.has('content-length'));
  yield encodeUtf8(_buildRequestHead(req, chunked));

  const body = req.body;
  if (body !== null) {
    for await (const chunk of body) {
      yield chunked ? _chunkedFrame(chunk) : chunk;
    }
  }

  if (chunked) {
    if (hasOutTrailers) {
      const rawTrailers = req._getRawOutTrailers();
      let trailers: Headers;
      if (rawTrailers instanceof Headers) {
        trailers = rawTrailers;
      } else if (typeof rawTrailers === 'function') {
        trailers = await (rawTrailers as () => Headers | Promise<Headers>)();
      } else {
        trailers = new Headers();
      }
      let trailerBlock = '0\r\n';
      for (const [name, value] of trailers) trailerBlock += name + ': ' + value + '\r\n';
      trailerBlock += '\r\n';
      yield encodeUtf8(trailerBlock);
    } else {
      yield LAST_CHUNK_BYTES;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers for fino:serve
// ---------------------------------------------------------------------------

/**
 * Create a persistent HTTP/1.x request parser for a single connection.
 * Returns an object with a `parseNext()` method that parses one request at a
 * time from a shared buffered reader, preserving leftover bytes between
 * requests — required for correct keep-alive (pipelined) behavior.
 *
 * Used by `fino:serve` so that multiple requests on the same TCP connection
 * share a single `_createReader` instance. Calling `parseRequest()` directly
 * would create a fresh reader each time and lose bytes between requests.
 *
 * `parseBufferedNext()` returns `null` when a complete next request header is
 * not already buffered.
 *
 * ```ts no_run
 * const parser = connectionParser(reader);
 * const req = await parser.parseNext();
 * ```
 */
export function connectionParser(source: AsyncIterable<Uint8Array>): { parseNext(): Promise<Request>, parseBufferedNext(): Request | null } {
  const reader = _createReader(source);
  function _requestFromRaw(raw: Uint8Array): Request {
    const { firstLine, headers } = _parseHeaders(raw);

    const { method, path, version } = _parseRequestLine(firstLine);
    const url = _urlFromRequestTarget(path, headers);

    const framing = _bodyFraming(headers, true, 0);
    let body;
    let inTrailers: Promise<Headers> | null = null;
    if (framing.type === 'fixed') {
      body = reader.bodyIterator(framing.length);
    } else if (framing.type === 'chunked') {
      const deferred = _makeTrailersDeferred();
      inTrailers = deferred.promise;
      body = reader.chunkedBodyIterator(deferred.resolve, deferred.reject);
    } else {
      body = _emptyBody;
    }

    return new Request(INTERNAL, { method, url, version, headers, body, inTrailers });
  }

  return {
    async parseNext() {
      return _requestFromRaw(await reader.readUntilDoubleCRLF());
    },
    parseBufferedNext() {
      const raw = reader.readUntilDoubleCRLFBuffered();
      return raw === null ? null : _requestFromRaw(raw);
    },
  };
}

/**
 * Build a Response from already-prepared wire components.
 * Used by `fino:serve` to inject `Connection` and `Content-Length` headers
 * and set the HTTP version without exposing the `INTERNAL` sentinel publicly.
 *
 * Missing `version` defaults to HTTP/1.1, missing `status` defaults to 200, and
 * missing body becomes a bodyless response.
 *
 * ```ts no_run
 * const wire = buildWireResponse({ headers: new Headers(), body: null, status: 204 });
 * ```
 */
export function buildWireResponse({ version, status, statusText, headers, body, url, redirected, outTrailers, inTrailers }: WireResponseInit): Response {
  return new Response(INTERNAL, {
    version:     version    || 'HTTP/1.1',
    status:      status     ?? 200,
    statusText:  statusText ?? '',
    headers,
    body:        body ?? _emptyBody,
    url,
    redirected,
    outTrailers: outTrailers ?? null,
    inTrailers:  inTrailers  ?? null,
  });
}

/**
 * Wrap bytes as a single-chunk async iterable. Exported for fino:serve.
 *
 * ```ts no_run
 * for await (const chunk of _iterableFromBytes(bytes)) console.log(chunk);
 * ```
 */
export { _iterableFromBytes, _concat };
