/**
 * boats:http — incremental HTTP/1.1 parser and serializer.
 *
 * This module implements HTTP/1.1 parsing and serialization entirely in JS,
 * building on Boats's async iterator model. There are no native bindings; the
 * parser is a hand-rolled state machine over byte chunks from any async source.
 *
 * It exports:
 *   - `Headers`           — WHATWG-compatible header map
 *   - `Request`           — Fetch API-compatible request (with async body)
 *   - `Response`          — Fetch API-compatible response (with async body)
 *   - `parseRequest(src)` — parse an incoming HTTP request from a byte stream
 *   - `parseResponse(src)`— parse an incoming HTTP response from a byte stream
 *   - `serializeRequest(req)`  — async iterable of wire bytes for a request
 *   - `serializeResponse(res)` — async iterable of wire bytes for a response
 *
 *
 * ## Intentional deviation from the Fetch spec
 *
 * The WHATWG Fetch spec uses `ReadableStream` for response/request bodies.
 * Boats does not implement ReadableStream (it's a large, complex API). Instead,
 * `body` is an async iterable of `Uint8Array` chunks, which is simpler and
 * composable with `for await` loops and `writer.pipe()`.
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
 * The `_concat(parts, totalLen)` helper always allocates a fresh buffer rather
 * than returning a subarray. This is necessary because the FFI `write(2)` call
 * uses the buffer's `byteOffset` to find the start of the data. A subarray of
 * a larger buffer (e.g. the Reader's 64 KiB socket buffer) would have a
 * nonzero `byteOffset` that the FFI layer ignores, causing writes to start
 * from byte 0 of the backing buffer instead of the intended data.
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
 */

import { decodeUtf8, encodeUtf8 } from 'internal:globals/encoding';
import { ReadableStream } from 'internal:globals/webstreams';
import { Blob } from 'internal:globals/blob';
import { FormData, _serializeFormData } from 'internal:globals/formdata';

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

interface RequestInit {
  method?:  string;
  headers?: HeadersInit;
  body?:    BodyInit;
}

interface ResponseInit {
  status?:     number;
  statusText?: string;
  headers?:    HeadersInit;
}

interface WireResponseInit {
  version?:    string;
  status?:     number;
  statusText?: string;
  headers:     Headers;
  body:        AsyncIterable<Uint8Array> | null;
  url?:        string;
  redirected?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CR = 0x0D; // '\r'
const LF = 0x0A; // '\n'
const SPACE = 0x20; // ' '

// Maximum header section size (prevents malicious clients from sending
// unbounded headers).  64 KiB should be plenty.
const MAX_HEADER_SIZE = 64 * 1024;

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
function _createReader(source) {
  const iter = source[Symbol.asyncIterator]();
  let buf = null;   // Uint8Array — leftover bytes from the current chunk
  let offset = 0;   // read position within `buf`
  let done = false;  // upstream exhausted?

  /** Pull the next chunk from the upstream iterator. */
  async function pull() {
    if (done) return false;
    const result = await iter.next();
    if (result.done) { done = true; return false; }
    const v = result.value;
    buf = v instanceof Uint8Array ? v : new Uint8Array(v);
    offset = 0;
    return true;
  }

  /** Return currently buffered but un-consumed bytes (may be empty). */
  function remaining() {
    if (buf === null || offset >= buf.byteLength) return null;
    return buf.subarray(offset);
  }

  /**
   * Read bytes until the header terminator "\r\n\r\n" is found.
   * Returns a single Uint8Array containing everything up to and including the
   * terminator.  Any bytes after the terminator are kept in the internal buffer
   * for subsequent body reads.
   */
  async function readUntilDoubleCRLF() {
    const parts = [];
    let totalLen = 0;

    // State machine: track how many bytes of "\r\n\r\n" we have matched.
    let matchCount = 0;
    const target = [CR, LF, CR, LF];

    while (true) {
      // Ensure we have data.
      if (buf === null || offset >= buf.byteLength) {
        if (!(await pull())) {
          throw new Error('Unexpected end of stream before header terminator');
        }
      }

      // Scan the current chunk for the terminator.
      const start = offset;
      while (offset < buf.byteLength) {
        if (buf[offset] === target[matchCount]) {
          matchCount++;
          if (matchCount === 4) {
            // Found the full terminator.  Include this byte in the header
            // segment and leave offset pointing to the byte AFTER.
            offset++;
            parts.push(buf.subarray(start, offset));
            totalLen += offset - start;
            return _concat(parts, totalLen);
          }
        } else {
          matchCount = buf[offset] === CR ? 1 : 0;
        }
        offset++;
      }

      // Consumed the whole chunk — stash what we read and loop.
      const slice = buf.subarray(start, offset);
      parts.push(slice);
      totalLen += slice.byteLength;

      if (totalLen > MAX_HEADER_SIZE) {
        throw new Error('HTTP header section exceeds ' + MAX_HEADER_SIZE + ' bytes');
      }
    }
  }

  /**
   * Return an async iterable that yields body data chunks.
   *
   * @param {number|null} contentLength  Known length, or null for read-until-EOF.
   */
  function bodyIterator(contentLength) {
    let bytesLeft = contentLength; // null ⇒ read until EOF

    return {
      [Symbol.asyncIterator]() { return this; },

      async next() {
        // Fixed-length body — stop when we've emitted enough bytes.
        if (bytesLeft !== null && bytesLeft <= 0) {
          return { done: true, value: undefined };
        }

        // Drain any leftover bytes from the header read first.
        const rem = remaining();
        if (rem !== null && rem.byteLength > 0) {
          buf = null;
          offset = 0;
          if (bytesLeft !== null) {
            if (rem.byteLength <= bytesLeft) {
              bytesLeft -= rem.byteLength;
              return { done: false, value: rem };
            }
            // More leftover than we need — slice.
            const slice = rem.subarray(0, bytesLeft);
            // Keep the rest for the next consumer (unlikely but correct).
            buf = rem;
            offset = bytesLeft;
            bytesLeft = 0;
            return { done: false, value: slice };
          }
          return { done: false, value: rem };
        }

        // Pull from upstream.
        if (!(await pull())) {
          return { done: true, value: undefined };
        }
        const chunk = buf.subarray(offset);

        if (bytesLeft !== null) {
          if (chunk.byteLength <= bytesLeft) {
            bytesLeft -= chunk.byteLength;
            buf = null;
            offset = 0;
            return { done: false, value: chunk };
          }
          // More data than needed — take what we need, keep the rest in buffer
          // for the next consumer (e.g. the next request header on keep-alive).
          const slice = chunk.subarray(0, bytesLeft);
          offset = bytesLeft; // buf stays as-is; offset points past the slice
          bytesLeft = 0;
          return { done: false, value: slice };
        }
        buf = null;
        offset = 0;
        return { done: false, value: chunk };
      },
    };
  }

  /**
   * Return an async iterable that decodes chunked transfer-encoding.
   *
   * Each HTTP chunk is: <hex-size>\r\n<data>\r\n
   * Terminated by a zero-length chunk: 0\r\n\r\n
   */
  function chunkedBodyIterator() {
    let finished = false;

    // Internal byte-level helpers.
    async function ensureData() {
      if (buf === null || offset >= buf.byteLength) {
        if (!(await pull())) throw new Error('Unexpected end of chunked stream');
      }
    }

    async function readByte() {
      await ensureData();
      return buf[offset++];
    }

    // Read bytes until CRLF and return them as a Uint8Array (excluding CRLF).
    async function readLine() {
      const parts = [];
      let total = 0;
      while (true) {
        await ensureData();
        const start = offset;
        while (offset < buf.byteLength) {
          if (buf[offset] === CR) {
            // Peek for LF
            parts.push(buf.subarray(start, offset));
            total += offset - start;
            offset++; // skip CR
            const lf = await readByte(); // should be LF
            if (lf !== LF) throw new Error('Expected LF after CR in chunk size line');
            return _concat(parts, total);
          }
          offset++;
        }
        parts.push(buf.subarray(start, offset));
        total += offset - start;
      }
    }

    // Read exactly `n` bytes.
    async function readExact(n) {
      if (n === 0) return new Uint8Array(0);
      const parts = [];
      let remaining = n;
      while (remaining > 0) {
        await ensureData();
        const avail = buf.byteLength - offset;
        const take = Math.min(avail, remaining);
        parts.push(buf.subarray(offset, offset + take));
        offset += take;
        remaining -= take;
      }
      return parts.length === 1 ? parts[0] : _concat(parts, n);
    }

    return {
      [Symbol.asyncIterator]() { return this; },

      async next() {
        if (finished) return { done: true, value: undefined };

        // Read the chunk-size line.
        const sizeLine = await readLine();
        const sizeStr = decodeUtf8(sizeLine).trim();
        // chunk-extensions (after ';') are ignored.
        const semi = sizeStr.indexOf(';');
        const hexStr = semi >= 0 ? sizeStr.substring(0, semi) : sizeStr;
        const chunkSize = parseInt(hexStr, 16);

        if (isNaN(chunkSize)) throw new Error('Invalid chunk size: ' + sizeStr);

        if (chunkSize === 0) {
          // Terminal chunk — consume trailing CRLF.
          const cr = await readByte();
          const lf = await readByte();
          if (cr !== CR || lf !== LF) {
            throw new Error('Expected CRLF after terminal chunk');
          }
          finished = true;
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
      },
    };
  }

  return { readUntilDoubleCRLF, bodyIterator, chunkedBodyIterator };
}

// ---------------------------------------------------------------------------
// Internal constructor sentinel + body helpers
// ---------------------------------------------------------------------------

/** Used to distinguish internal wire-parse construction from spec-style construction. */
const INTERNAL = Symbol('internal');

/** Wrap a Uint8Array as a single-chunk async iterable. */
function _iterableFromBytes(bytes) {
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
function _toBytes(body) {
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
 */
export class Headers {
  #list: [string, string][];

  constructor(init?: HeadersInit) {
    this.#list = []; // [[name, value], ...]
    if (init == null) return;
    if (init instanceof Headers) {
      this.#list = init.#list.slice();
    } else if (Array.isArray(init)) {
      for (const pair of init) {
        this.append(pair[0], pair[1]);
      }
    } else if (typeof init === 'object') {
      for (const name of Object.keys(init)) {
        this.append(name, init[name]);
      }
    }
  }

  /**
   * Append a new value for the given header name.
   * If the header already exists, the new value is added alongside the old.
   */
  append(name: string, value: string): void {
    name = _normalizeHeaderName(name);
    value = _normalizeHeaderValue(value);
    this.#list.push([name, value]);
  }

  /**
   * Set the value for a header name, replacing any existing values.
   */
  set(name: string, value: string): void {
    name = _normalizeHeaderName(name);
    value = _normalizeHeaderValue(value);
    let replaced = false;
    const next = [];
    for (const entry of this.#list) {
      if (entry[0] === name) {
        if (!replaced) { next.push([name, value]); replaced = true; }
        // else drop duplicate
      } else {
        next.push(entry);
      }
    }
    if (!replaced) next.push([name, value]);
    this.#list = next;
  }

  /**
   * Return the combined value for the given name, or null if not present.
   * Multiple values are joined with ", ".
   */
  get(name: string): string | null {
    name = name.toLowerCase().trim();
    const values = [];
    for (const entry of this.#list) {
      if (entry[0] === name) values.push(entry[1]);
    }
    return values.length === 0 ? null : values.join(', ');
  }

  /** Return true if a header with the given name exists. */
  has(name: string): boolean {
    name = name.toLowerCase().trim();
    for (const entry of this.#list) {
      if (entry[0] === name) return true;
    }
    return false;
  }

  /** Remove all values for the given header name. */
  delete(name: string): void {
    name = name.toLowerCase().trim();
    this.#list = this.#list.filter(function(entry) { return entry[0] !== name; });
  }

  /**
   * Return an array of all Set-Cookie header values without joining.
   * Use this instead of get('set-cookie') to avoid value ambiguity.
   */
  getSetCookie() {
    return this.#list
      .filter(function(entry) { return entry[0] === 'set-cookie'; })
      .map(function(entry) { return entry[1]; });
  }

  /** Return an iterator over [name, value] pairs, sorted by name. */
  entries() {
    return this.#sorted()[Symbol.iterator]();
  }

  /** Return an iterator over header names, sorted. */
  keys() {
    return this.#sorted().map(function(e) { return e[0]; })[Symbol.iterator]();
  }

  /** Return an iterator over header values, sorted by name. */
  values() {
    return this.#sorted().map(function(e) { return e[1]; })[Symbol.iterator]();
  }

  /** Iterate over [name, value] pairs, sorted by name. */
  forEach(callback, thisArg) {
    for (const entry of this.#sorted()) {
      callback.call(thisArg, entry[1], entry[0], this);
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  #sorted() {
    return this.#list.slice().sort(function(a, b) {
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
  }
}

function _normalizeHeaderName(name) {
  name = String(name).toLowerCase().trim();
  if (!name) throw new TypeError('Header name must not be empty');
  return name;
}

function _normalizeHeaderValue(value) {
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
 * @param {Uint8Array} raw
 * @returns {{ firstLine: string, headers: Headers }}
 */
function _parseHeaders(raw) {
  const text = decodeUtf8(raw);
  const lines = text.split('\r\n');

  // First line: request-line or status-line.
  const firstLine = lines[0];

  const headers = new Headers();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) break; // end of headers

    // Handle header continuations (obs-fold: line starts with SP or HT).
    if (line.charCodeAt(0) === SPACE || line.charCodeAt(0) === 0x09) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue; // malformed line — skip
    const name  = line.substring(0, colonIdx).toLowerCase().trim();
    const value = line.substring(colonIdx + 1).trim();
    if (name) headers.append(name, value);
  }

  return { firstLine, headers };
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
function _bodyFraming(headers, isRequest, statusCode) {
  // Responses to HEAD, 1xx, 204, 304 have no body.
  if (!isRequest) {
    if (statusCode >= 100 && statusCode < 200) return { type: 'none' };
    if (statusCode === 204 || statusCode === 304) return { type: 'none' };
  }

  const te = headers.get('transfer-encoding');
  if (te) {
    const last = te.split(',').pop().trim().toLowerCase();
    if (last === 'chunked') return { type: 'chunked' };
  }

  const cl = headers.get('content-length');
  if (cl !== null) {
    const len = parseInt(cl, 10);
    if (!isNaN(len)) return { type: 'fixed', length: len };
  }

  // Requests with no Content-Length and no Transfer-Encoding have no body.
  if (isRequest) return { type: 'none' };

  // Responses without either header: read until EOF.
  return { type: 'eof' };
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
 */
export class Request {
  #bodyUsed: boolean;
  #method: string;
  #url: string;
  #version: string;
  #headers: Headers;
  #rawBody: AsyncIterable<Uint8Array> | null;
  #bodyStream: ReadableStream | null = null;

  constructor(input: string | Request | symbol, init?: RequestInit | any) {
    this.#bodyUsed = false;

    if (input === INTERNAL) {
      this.#method  = init.method;
      this.#url     = init.url;
      this.#version = init.version;
      this.#headers = init.headers;
      this.#rawBody = init.body === _emptyBody ? null : init.body;
      return;
    }

    // Spec-style construction.
    this.#url     = input instanceof Request ? input.#url : String(input);
    const rawMethod = (init && init.method) ? String(init.method) : 'GET';
    // Per Fetch spec, only these six methods are normalized to uppercase.
    this.#method  = /^(delete|get|head|options|post|put)$/i.test(rawMethod) ? rawMethod.toUpperCase() : rawMethod;
    this.#headers = (init && init.headers) ? new Headers(init.headers) : new Headers();
    this.#version = '';
    if (init && init.body != null) {
      if (init.body instanceof FormData) {
        const fd = init.body;
        const boundary = 'boundary' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        if (!this.#headers.has('content-type')) {
          this.#headers.set('content-type', `multipart/form-data; boundary=${boundary}`);
        }
        this.#rawBody = { [Symbol.asyncIterator]: async function*() {
          const { body } = await _serializeFormData(fd, boundary);
          yield body;
        } };
      } else {
        this.#rawBody = _iterableFromBytes(_toBytes(init.body));
      }
    } else {
      this.#rawBody = null;
    }
  }

  /** The full URL string. */
  get url() { return this.#url; }

  /** HTTP method (uppercase). */
  get method() { return this.#method; }

  /** Request headers. */
  get headers() { return this.#headers; }

  /**
   * The body as a ReadableStream, or null if no body.
   * Returns the same stream on repeated access (spec: [SameObject]).
   */
  get body(): ReadableStream | null {
    if (this.#rawBody === null) return null;
    return this.#bodyStream ??= ReadableStream.from(this.#rawBody);
  }

  /** True if the body has been read or the stream is locked. */
  get bodyUsed() {
    return this.#bodyUsed || (this.#bodyStream !== null && this.#bodyStream.locked);
  }

  /** HTTP version string — boats extension (e.g. "HTTP/1.1"). */
  get version() { return this.#version; }

  /** True if the request has a body. */
  get hasBody() { return this.#rawBody !== null; }

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

  /** Consume body and return as a UTF-8 string. */
  async text() { return decodeUtf8(await this.#consumeBody()); }

  /** Consume body and parse as JSON. */
  async json() { return JSON.parse(await this.text()); }

  /** Consume body and return as ArrayBuffer. */
  async arrayBuffer() {
    const bytes = await this.#consumeBody();
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  }

  /** Consume body and return as Uint8Array. */
  async bytes() { return this.#consumeBody(); }

  /** Consume body and return as a Blob. */
  async blob() {
    const buf = await this.arrayBuffer();
    const type = this.#headers.get('content-type') || '';
    return new Blob([buf], { type });
  }

  /** Create an independent copy of this request. */
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
   * @param {AsyncIterable<Uint8Array|ArrayBuffer>} source
   * @returns {Promise<Request>}
   */
  static from(source) { return parseRequest(source); }
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
 */
export class Response {
  #bodyUsed: boolean;
  #url: string;
  #type: string;
  #redirected: boolean;
  #version: string;
  #status: number;
  #statusText: string;
  #headers: Headers;
  #rawBody: AsyncIterable<Uint8Array> | null;
  #bodyStream: ReadableStream | null = null;

  constructor(body: BodyInit | symbol, init?: ResponseInit | any) {
    this.#bodyUsed   = false;
    this.#url        = '';
    this.#type       = 'default';
    this.#redirected = false;

    if (body === INTERNAL) {
      this.#version    = init.version;
      this.#status     = init.status;
      this.#statusText = init.statusText;
      this.#headers    = init.headers;
      this.#rawBody    = init.body === _emptyBody ? null : init.body;
      if (init.url !== undefined) this.#url = init.url;
      if (init.redirected !== undefined) this.#redirected = init.redirected;
      return;
    }

    // Spec-style construction.
    this.#version    = '';
    this.#status     = (init && init.status != null) ? Number(init.status) : 200;
    this.#statusText = (init && init.statusText != null) ? String(init.statusText) : '';
    this.#headers    = (init && init.headers) ? new Headers(init.headers) : new Headers();
    if (body != null) {
      if (body instanceof FormData) {
        const fd = body;
        const boundary = 'boundary' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        if (!this.#headers.has('content-type')) {
          this.#headers.set('content-type', `multipart/form-data; boundary=${boundary}`);
        }
        this.#rawBody = { [Symbol.asyncIterator]: async function*() {
          const { body: bytes } = await _serializeFormData(fd, boundary);
          yield bytes;
        } };
      } else {
        this.#rawBody = _iterableFromBytes(_toBytes(body));
      }
    } else {
      this.#rawBody = null;
    }
  }

  /** True if status is in the 200–299 range. */
  get ok() { return this.#status >= 200 && this.#status < 300; }

  /** HTTP status code. */
  get status() { return this.#status; }

  /** HTTP reason phrase. */
  get statusText() { return this.#statusText; }

  /** Response headers. */
  get headers() { return this.#headers; }

  /**
   * The body as a ReadableStream, or null if no body.
   * Returns the same stream on repeated access (spec: [SameObject]).
   */
  get body(): ReadableStream | null {
    if (this.#rawBody === null) return null;
    return this.#bodyStream ??= ReadableStream.from(this.#rawBody);
  }

  /** True if the body has been read or the stream is locked. */
  get bodyUsed() {
    return this.#bodyUsed || (this.#bodyStream !== null && this.#bodyStream.locked);
  }

  /** Final URL (empty for constructed responses; set by fetch clients). */
  get url() { return this.#url; }

  /** Response type — always "default" or "error". */
  get type() { return this.#type; }

  /** True if the response is the result of a redirect. */
  get redirected() { return this.#redirected; }

  /** HTTP version string — boats extension (e.g. "HTTP/1.1"). */
  get version() { return this.#version; }

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

  /** Consume body and return as a UTF-8 string. */
  async text() { return decodeUtf8(await this.#consumeBody()); }

  /** Consume body and parse as JSON. */
  async json() { return JSON.parse(await this.text()); }

  /** Consume body and return as ArrayBuffer. */
  async arrayBuffer() {
    const bytes = await this.#consumeBody();
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  }

  /** Consume body and return as Uint8Array. */
  async bytes() { return this.#consumeBody(); }

  /** Consume body and return as a Blob. */
  async blob() {
    const buf = await this.arrayBuffer();
    const type = this.#headers.get('content-type') || '';
    return new Blob([buf], { type });
  }

  /** Create an independent copy of this response. */
  clone(): Response {
    if (this.bodyUsed) throw new TypeError('Cannot clone a disturbed Response');
    if (this.#rawBody === null) {
      const cloned = new Response(INTERNAL, { version: this.#version, status: this.#status, statusText: this.#statusText, headers: new Headers(this.#headers), body: _emptyBody, url: this.#url, redirected: this.#redirected });
      cloned.#type = this.#type;
      return cloned;
    }
    const stream = this.#bodyStream ?? ReadableStream.from(this.#rawBody);
    const [a, b] = stream.tee();
    this.#bodyStream = a;
    this.#rawBody = a as any;
    const cloned = new Response(INTERNAL, { version: this.#version, status: this.#status, statusText: this.#statusText, headers: new Headers(this.#headers), body: b, url: this.#url, redirected: this.#redirected });
    cloned.#type = this.#type;
    return cloned;
  }

  /**
   * Create a Response with a JSON-serialised body and
   * Content-Type: application/json.
   */
  static json(data, init) {
    const body = JSON.stringify(data);
    const headers = new Headers((init && init.headers) ? init.headers : {});
    headers.set('content-type', 'application/json');
    const status     = (init && init.status     != null) ? init.status     : 200;
    const statusText = (init && init.statusText != null) ? init.statusText : '';
    return new Response(body, { status, statusText, headers });
  }

  /**
   * Create a redirect Response.
   * @param {string} url
   * @param {number} [status=302]
   */
  static redirect(url, status) {
    status = (status != null) ? Number(status) : 302;
    if (![301, 302, 303, 307, 308].includes(status)) {
      throw new RangeError(`Response.redirect: invalid redirect status ${status}`);
    }
    const headers = new Headers({ location: String(url) });
    return new Response(null, { status, headers });
  }

  /**
   * Create a network error Response (type "error", status 0).
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
   * @param {AsyncIterable<Uint8Array|ArrayBuffer>} source
   * @returns {Promise<Response>}
   */
  static from(source) { return parseResponse(source); }
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
 * @param {AsyncIterable<Uint8Array|ArrayBuffer>} source
 * @returns {Promise<Request>}
 */
export async function parseRequest(source: AsyncIterable<Uint8Array | ArrayBuffer>): Promise<Request> {
  const reader = _createReader(source);
  const raw = await reader.readUntilDoubleCRLF();
  const { firstLine, headers } = _parseHeaders(raw);

  // Request-Line: METHOD SP Request-URI SP HTTP-Version
  const parts = firstLine.split(' ');
  const method  = (parts[0] || 'GET').toUpperCase();
  const path    = parts[1] || '/';
  const version = parts.slice(2).join(' ') || 'HTTP/1.1';

  const host = headers.get('host');
  const url  = host ? 'http://' + host + path : path;

  const framing = _bodyFraming(headers, true, 0);
  let body;
  if (framing.type === 'fixed')        body = reader.bodyIterator(framing.length);
  else if (framing.type === 'chunked') body = reader.chunkedBodyIterator();
  else                                 body = _emptyBody;

  return new Request(INTERNAL, { method, url, version, headers, body });
}

/**
 * Parse an HTTP/1.x response from an async iterable of byte chunks.
 *
 * @param {AsyncIterable<Uint8Array|ArrayBuffer>} source
 * @returns {Promise<Response>}
 */
export async function parseResponse(source: AsyncIterable<Uint8Array | ArrayBuffer>): Promise<Response> {
  const reader = _createReader(source);
  const raw = await reader.readUntilDoubleCRLF();
  const { firstLine, headers } = _parseHeaders(raw);

  // Status-Line: HTTP-Version SP Status-Code SP Reason-Phrase
  const parts = firstLine.split(' ');
  const version    = parts[0] || 'HTTP/1.1';
  const status     = parseInt(parts[1], 10) || 0;
  const statusText = parts.slice(2).join(' ') || '';

  const framing = _bodyFraming(headers, false, status);
  let body;
  if (framing.type === 'fixed')        body = reader.bodyIterator(framing.length);
  else if (framing.type === 'chunked') body = reader.chunkedBodyIterator();
  else if (framing.type === 'eof')     body = reader.bodyIterator(null);
  else                                 body = _emptyBody;

  return new Response(INTERNAL, { version, status, statusText, headers, body });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Concatenate an array of Uint8Array slices into a single Uint8Array. */
function _concat(parts, totalLen) {
  // Always allocate a fresh buffer so the result has byteOffset=0.
  // Returning a subarray of a larger buffer (e.g. the Reader's 64 KiB socket
  // buffer) would give a nonzero byteOffset that the FFI write call ignores,
  // causing writes to start from byte 0 of the underlying buffer instead of
  // the intended offset.
  const result = new Uint8Array(totalLen);
  let pos = 0;
  for (const p of parts) {
    result.set(p, pos);
    pos += p.byteLength;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/** Extract the path+query from a URL string (may be absolute or path-only). */
function _pathFromUrl(url) {
  const schemeEnd = url.indexOf('://');
  if (schemeEnd !== -1) {
    const hostStart = schemeEnd + 3;
    const slashIdx  = url.indexOf('/', hostStart);
    return slashIdx >= 0 ? url.substring(slashIdx) : '/';
  }
  return url || '/';
}

/** Extract the host (with optional port) from an absolute URL, or null. */
function _hostFromUrl(url) {
  const schemeEnd = url.indexOf('://');
  if (schemeEnd === -1) return null;
  const hostStart = schemeEnd + 3;
  const slashIdx  = url.indexOf('/', hostStart);
  return slashIdx >= 0 ? url.substring(hostStart, slashIdx) : url.substring(hostStart);
}

/** Serialize HTTP response headers to a string (status-line + headers + CRLF). */
function _buildResponseHead(res) {
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
function _buildRequestHead(req, chunked) {
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
function _chunkedFrame(bytes) {
  const sizeLine = encodeUtf8(bytes.byteLength.toString(16) + '\r\n');
  const crlf     = encodeUtf8('\r\n');
  const out = new Uint8Array(sizeLine.byteLength + bytes.byteLength + crlf.byteLength);
  out.set(sizeLine, 0);
  out.set(bytes, sizeLine.byteLength);
  out.set(crlf, sizeLine.byteLength + bytes.byteLength);
  return out;
}

/**
 * Serialize a Response to an async iterable of Uint8Array chunks suitable for
 * piping to a TCP connection: status-line + headers first, then body chunks.
 *
 * @param {Response} res
 * @returns {AsyncIterable<Uint8Array>}
 */
export function serializeResponse(res: Response): AsyncIterable<Uint8Array> {
  const te = (res.headers.get('transfer-encoding') || '').toLowerCase();
  const isChunked = te.split(',').map(s => s.trim()).includes('chunked');

  return {
    [Symbol.asyncIterator]() {
      let headerSent = false;
      let bodyIter   = null;
      let bodyDone   = false;
      return {
        async next() {
          if (!headerSent) {
            headerSent = true;
            return { done: false, value: encodeUtf8(_buildResponseHead(res)) };
          }
          if (bodyDone) return { done: true, value: undefined };
          if (bodyIter === null) {
            const body = res.body;
            if (body === null) return { done: true, value: undefined };
            bodyIter = body[Symbol.asyncIterator]();
          }
          const { done, value } = await bodyIter.next();
          if (done) {
            if (isChunked) { bodyDone = true; return { done: false, value: encodeUtf8('0\r\n\r\n') }; }
            return { done: true, value: undefined };
          }
          if (isChunked) return { done: false, value: _chunkedFrame(value) };
          return { done: false, value };
        },
      };
    },
  };
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
 * @param {Request} req
 * @returns {AsyncIterable<Uint8Array>}
 */
export function serializeRequest(req: Request): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      let headerSent = false;
      let bodyIter   = null;
      let chunked    = false;
      return {
        async next() {
          if (!headerSent) {
            headerSent = true;
            chunked = req.hasBody && !req.headers.has('content-length');
            return { done: false, value: encodeUtf8(_buildRequestHead(req, chunked)) };
          }
          if (bodyIter === null) {
            const body = req.body;
            if (body === null) return { done: true, value: undefined };
            bodyIter = body[Symbol.asyncIterator]();
          }
          const result = await bodyIter.next();
          if (result.done) {
            if (chunked) { chunked = false; return { done: false, value: encodeUtf8('0\r\n\r\n') }; }
            return { done: true, value: undefined };
          }
          if (chunked) return { done: false, value: _chunkedFrame(result.value) };
          return result;
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers for boats:serve
// ---------------------------------------------------------------------------

/**
 * Create a persistent HTTP/1.x request parser for a single connection.
 * Returns an object with a `parseNext()` method that parses one request at a
 * time from a shared buffered reader, preserving leftover bytes between
 * requests — required for correct keep-alive (pipelined) behavior.
 *
 * Used by `boats:serve` so that multiple requests on the same TCP connection
 * share a single `_createReader` instance. Calling `parseRequest()` directly
 * would create a fresh reader each time and lose bytes between requests.
 *
 * @param {AsyncIterable<Uint8Array>} source — socket reader
 * @returns {{ parseNext(): Promise<Request> }}
 */
export function connectionParser(source: AsyncIterable<Uint8Array>): { parseNext(): Promise<Request> } {
  const reader = _createReader(source);
  return {
    async parseNext() {
      const raw = await reader.readUntilDoubleCRLF();
      const { firstLine, headers } = _parseHeaders(raw);

      const parts   = firstLine.split(' ');
      const method  = (parts[0] || 'GET').toUpperCase();
      const path    = parts[1] || '/';
      const version = parts.slice(2).join(' ') || 'HTTP/1.1';

      const host = headers.get('host');
      const url  = host ? 'http://' + host + path : path;

      const framing = _bodyFraming(headers, true, 0);
      let body;
      if (framing.type === 'fixed')        body = reader.bodyIterator(framing.length);
      else if (framing.type === 'chunked') body = reader.chunkedBodyIterator();
      else                                 body = _emptyBody;

      return new Request(INTERNAL, { method, url, version, headers, body });
    },
  };
}

/**
 * Build a Response from already-prepared wire components.
 * Used by `boats:serve` to inject `Connection` and `Content-Length` headers
 * and set the HTTP version without exposing the `INTERNAL` sentinel publicly.
 *
 * @param {{ version: string, status: number, statusText: string, headers: Headers, body: AsyncIterable|null }} opts
 * @returns {Response}
 */
export function buildWireResponse({ version, status, statusText, headers, body, url, redirected }: WireResponseInit): Response {
  return new Response(INTERNAL, {
    version:    version    || 'HTTP/1.1',
    status:     status     ?? 200,
    statusText: statusText ?? '',
    headers,
    body: body ?? _emptyBody,
    url,
    redirected,
  });
}

/**
 * Wrap bytes as a single-chunk async iterable. Exported for boats:serve.
 * @param {Uint8Array} bytes
 * @returns {AsyncIterable<Uint8Array>}
 */
export { _iterableFromBytes, _concat };
