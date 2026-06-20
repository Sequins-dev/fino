# js/net/http

fino:http — incremental HTTP/1.1 parser and serializer.

This module implements HTTP/1.1 parsing and serialization entirely in JS,
building on Fino's async iterator model. There are no native bindings; the
parser is a hand-rolled state machine over byte chunks from any async source.

It exports:
  - `Headers`           — WHATWG-compatible header map
  - `Request`           — Fetch API-compatible request (with async body)
  - `Response`          — Fetch API-compatible response (with async body)
  - `parseRequest(src)` — parse an incoming HTTP request from a byte stream
  - `parseResponse(src)`— parse an incoming HTTP response from a byte stream
  - `serializeRequest(req)`  — async iterable of wire bytes for a request
  - `serializeResponse(res)` — async iterable of wire bytes for a response

## Body streams

Request and Response bodies are exposed as `ReadableStream | null`.
Constructors accept byte buffers, strings, `FormData`, async iterables, and
`ReadableStream` instances. The body helpers and serializers consume those
streams with async iteration while preserving Fetch-style `bodyUsed`
semantics.

## How parsing works: _createReader

The parser is built on a shared `_createReader(source)` helper that wraps
any async iterable of byte chunks into a stateful buffered reader. This
reader provides two higher-level operations:

  1. `readUntilDoubleCRLF()` — reads bytes until the `\r\n\r\n` header
     terminator is found. Uses a 4-state match counter to avoid scanning
     the accumulation buffer from scratch each time. Returns a Uint8Array
     containing everything up through the terminator.

  2. `bodyIterator(contentLength | null)` — returns an async iterable that
     yields body data. If `contentLength` is a number, it yields exactly
     that many bytes. If null, it reads until the underlying source is
     exhausted (EOF body framing, used for HTTP responses without
     Content-Length).

  3. `chunkedBodyIterator()` — reads HTTP chunked transfer-encoding. Each
     chunk starts with a hex size line (`<hex>\r\n`), followed by the chunk
     data, followed by `\r\n`. The sequence ends with `0\r\n\r\n`.

## Body framing detection

After parsing headers, `_bodyFraming(headers, isRequest, statusCode)` decides
how the body is delimited:
  - `{ type: 'fixed', length: N }` — `Content-Length` header present
  - `{ type: 'chunked' }`          — `Transfer-Encoding: chunked`
  - `{ type: 'eof' }`              — response with no framing (read to EOF)
  - `{ type: 'none' }`             — no body (HEAD/1xx/204/304/requests
                                     without Content-Length)

## The INTERNAL sentinel

`Request` and `Response` have two construction paths:
  1. **Spec-style**: `new Request(url, init)` / `new Response(body, init)`
     Constructs from user-supplied data. No wire parsing involved.
  2. **Wire-parse**: `new Request(INTERNAL, parsed)` / `new Response(INTERNAL, parsed)`
     Used internally by `parseRequest()` / `parseResponse()` to construct
     objects from parsed wire data (already-decoded method, headers, body
     iterator). The `INTERNAL` symbol prevents external code from accidentally
     using this path.

## bodyUsed guard

Once a body has been iterated (via `.body[Symbol.asyncIterator]()` or
any of `.text()` / `.json()` / `.bytes()`), `bodyUsed` is set to true
and any subsequent attempt to read the body throws `TypeError`. This mirrors
the Fetch spec's "disturbed" stream semantics.

## Serialization and _concat

`serializeResponse()` and `serializeRequest()` return async iterables that
yield the status/request line + headers as the first chunk, then the body
chunks. For requests with a body but no `Content-Length`, chunked encoding
is injected automatically.

The `_concat(parts, totalLen, arena?)` helper merges slices into a single
buffer. When an `Arena` is provided, the result is a view into the arena's
backing buffer (zero allocation). The FFI `write(2)` call correctly handles
the non-zero `byteOffset` of arena views.

## Contributing

- The header size limit (`MAX_HEADER_SIZE = 64 KiB`) protects against
  clients that try to exhaust memory by sending unbounded headers.
- The `_bodyFraming` function encodes the HTTP/1.1 framing rules from
  RFC 7230 §3.3. If you need to support HEAD requests on the server side,
  you'll need to pass the request method into the response framing logic.
- `Headers` stores a flat `[name, value]` pair array internally. This is
  simple and spec-compliant, but O(n) for lookups. For typical HTTP headers
  (< 50 entries) this is fine; for exotic use cases, a Map could be used.

```ts
import { Request, Response, parseRequest, serializeResponse } from 'fino:http';

const request = new Request('https://example.test/', { method: 'POST', body: 'hello' });
const response = new Response(await request.text(), {
  status: 201,
  headers: { 'content-type': 'text/plain' },
});
for await (const chunk of serializeResponse(response)) {
  await writer.write(chunk);
}
```

## Arena

```ts
class Arena {
```

Bump allocator backed by a single ArrayBuffer.

Each `alloc(n)` returns a `Uint8Array` view at the current cursor, advances
the cursor by `n`, and never allocates a new backing store. `reset()` sets
the cursor back to zero, logically freeing all previous allocations in O(1).

Used to eliminate per-request allocations for response encoding. All bytes
written into arena views are consumed by `write(2)` before `reset()` is
called, so there is no aliasing hazard. If the arena is full, `alloc()`
falls back to a regular `new Uint8Array(n)` — no failure mode.

The FFI layer correctly handles the non-zero `byteOffset` of arena views
when they are passed to `write(2)` as `buffer` arguments.

```ts
const arena = new Arena(4096);
const bytes = arena.alloc(128);
arena.reset();
```

### constructor

```ts
constructor(size: number = 8192)
```

Create an arena with the requested backing-buffer size.

```ts
const arena = new Arena(65536);
```

### alloc

```ts
alloc(n: number): Uint8Array
```

Allocate a `Uint8Array` view of `n` bytes.

If the arena has insufficient remaining space, this returns a standalone
`Uint8Array` instead of throwing. Previously returned arena views are
invalidated logically by `reset()` but not zeroed.

```ts
const header = arena.alloc(64);
```

### reset

```ts
reset(): void
```

Reset the allocation cursor to the beginning of the backing buffer.

Call this only after all views allocated from the arena have been consumed.

```ts
arena.reset();
```

## Headers

```ts
class Headers {
```

WHATWG-compatible Headers class.

Internal storage is an array of [name, value] pairs with lowercased names.
Iteration order is sorted ascending by name (per spec).

```ts
const headers = new Headers({ 'Content-Type': 'text/plain' });
headers.append('Set-Cookie', 'sid=1');
```

### constructor

```ts
constructor(init?: HeadersInit)
```

Create a header map from another `Headers`, pair array, object, or nothing.

Header names are normalized to lowercase and values are trimmed. Invalid
pair entries throw `TypeError`.

```ts
const headers = new Headers([['content-type', 'application/json']]);
```

### append

```ts
append(name: string, value: string): void
```

Append a new value for the given header name.
If the header already exists, the new value is added alongside the old.

```ts
headers.append('set-cookie', 'a=1');
```

### _appendTrusted

```ts
_appendTrusted(name: string, value: string): void
```

Internal: append a pre-normalized [name, value] pair without validation.
name must already be lowercased and trimmed; value must already be trimmed
and free of control characters (guaranteed for wire-parsed headers).

```ts
headers._appendTrusted('host', 'example.com');
```

### set

```ts
set(name: string, value: string): void
```

Set the value for a header name, replacing any existing values.

```ts
headers.set('content-type', 'application/json');
```

### get

```ts
get(name: string): string | null
```

Return the combined value for the given name, or null if not present.
Multiple values are joined with ", ".

Use `getSetCookie()` for `Set-Cookie`, which must not be interpreted as a
comma-joined list.

```ts
const contentType = headers.get('content-type') ?? 'application/octet-stream';
```

### has

```ts
has(name: string): boolean
```

Return true if a header with the given name exists.

```ts
if (headers.has('content-length')) console.log(headers.get('content-length'));
```

### delete

```ts
delete(name: string): void
```

Remove all values for the given header name.

```ts
headers.delete('transfer-encoding');
```

### getSetCookie

```ts
getSetCookie()
```

Return an array of all Set-Cookie header values without joining.
Use this instead of get('set-cookie') to avoid value ambiguity.

```ts
for (const cookie of headers.getSetCookie()) console.log(cookie);
```

### entries

```ts
entries()
```

Return an iterator over [name, value] pairs, sorted by name.

```ts
for (const [name, value] of headers.entries()) console.log(name, value);
```

### keys

```ts
keys()
```

Return an iterator over header names, sorted.

```ts
for (const name of headers.keys()) console.log(name);
```

### values

```ts
values()
```

Return an iterator over header values, sorted by name.

```ts
for (const value of headers.values()) console.log(value);
```

### forEach

```ts
forEach(callback: (value: string, name: string, headers: Headers) => void, thisArg?: unknown): void
```

Iterate over [name, value] pairs, sorted by name.

```ts
headers.forEach((value, name) => console.log(name, value));
```

## _parseHeaders

```ts
function _parseHeaders(raw: Uint8Array): {
  firstLine: string;
  headers: Headers;
}
```

Parse a raw header block (everything up to and including "\r\n\r\n") into
a Headers instance.  Header names are lowercased; values are trimmed.

Throws on obsolete folded header lines or malformed header syntax.

```ts
const { firstLine, headers } = _parseHeaders(rawHeaderBytes);
```

## Request

```ts
class Request {
```

Fetch API-compatible Request class.

Spec-style constructor: new Request(url, init?)
  url  — URL string or another Request
  init — { method?, headers?, body? }

Wire-parse constructor (internal): new Request(INTERNAL, { method, url, version, headers, body })

```ts
const req = new Request('https://example.com/api', {
  method: 'POST',
  body: JSON.stringify({ ok: true }),
});
```

### constructor

```ts
constructor(input: string | Request | symbol, init?: RequestInit | any)
```

Create a Request from a URL string, another Request, or the internal parser
sentinel.

Body values may be strings, bytes, ArrayBuffers, FormData, async iterables,
ReadableStreams, or null. Reading the body later marks it used; cloning is
only allowed before disturbance.

```ts
const req = new Request('/submit', { method: 'POST', body: 'hello' });
```

### trailers

```ts
get trailers(): Promise<Headers>
```

Incoming trailer headers, resolving after a chunked body is fully consumed.

For constructed outbound requests with trailer metadata, this resolves that
metadata immediately. Otherwise it resolves to an empty `Headers` object.

```ts
const trailers = await req.trailers;
```

### url

```ts
get url()
```

The full URL string.

Parsed server requests are made absolute from `Host` when possible.

```ts
console.log(req.url);
```

### method

```ts
get method()
```

HTTP method.

Common Fetch methods are normalized to uppercase during construction.

```ts
if (req.method === 'POST') console.log('has body');
```

### headers

```ts
get headers()
```

Mutable request headers.

```ts
req.headers.set('authorization', 'Bearer token');
```

### body

```ts
get body(): ReadableStream | null
```

The body as a ReadableStream, or null if no body.
Returns the same stream on repeated access (spec: [SameObject]).

Accessing the stream does not consume it immediately, but locking or
reading it makes `bodyUsed` true.

```ts
if (req.body !== null) for await (const chunk of req.body) console.log(chunk);
```

### bodyUsed

```ts
get bodyUsed()
```

True if the body has been read or the stream is locked.

```ts
if (!req.bodyUsed) console.log(await req.text());
```

### version

```ts
get version()
```

HTTP version string, a Fino extension for parsed wire requests.

Constructed requests use an empty string until serialized.

```ts
console.log(req.version || 'not parsed from wire');
```

### hasBody

```ts
get hasBody()
```

True if the request has a body.

```ts
if (req.hasBody) await req.bytes();
```

### text

```ts
async text()
```

Consume body and return as a UTF-8 string.

Throws `TypeError` if the body has already been consumed.

```ts
const text = await req.text();
```

### json

```ts
async json()
```

Consume body and parse as JSON.

Throws `TypeError` if consumed already and propagates `JSON.parse` errors.

```ts
const data = await req.json();
```

### arrayBuffer

```ts
async arrayBuffer()
```

Consume body and return as a copied ArrayBuffer.

```ts
const buffer = await req.arrayBuffer();
```

### bytes

```ts
async bytes()
```

Consume body and return as Uint8Array.

```ts
const bytes = await req.bytes();
```

### blob

```ts
async blob()
```

Consume body and return as a Blob.

The Blob type is taken from the `content-type` header when present.

```ts
const blob = await req.blob();
```

### clone

```ts
clone(): Request
```

Create an independent copy of this request.

Throws if the body has already been consumed or locked. Streaming bodies are
teed so both copies can be read independently.

```ts
const clone = req.clone();
```

### from

```ts
static from(source: AsyncByteSource)
```

Parse an HTTP/1.x request from an async iterable of byte chunks
(e.g. a TCP connection).

Throws on malformed headers, invalid framing, or stream EOF before the
header terminator.

```ts
const req = await Request.from(reader);
```

## Response

```ts
class Response {
```

Fetch API-compatible Response class.

Spec-style constructor: new Response(body?, init?)
  body — string | ArrayBuffer | Uint8Array | null
  init — { status?, statusText?, headers? }

Wire-parse constructor (internal): new Response(INTERNAL, { version, status, statusText, headers, body })

Static factories: Response.json(), Response.redirect(), Response.error()

```ts
const res = new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } });
```

### constructor

```ts
constructor(body: BodyInit | symbol, init?: ResponseInit | any)
```

Create a response from body data and optional status, headers, and trailers.

Status defaults to 200 and statusText defaults to the empty string. Body
reads are single-use unless the response is cloned before consumption.

```ts
const res = new Response(JSON.stringify({ ok: true }), { status: 201 });
```

### ok

```ts
get ok()
```

True if status is in the 200-299 range.

```ts
if (res.ok) console.log(await res.text());
```

### status

```ts
get status()
```

HTTP status code.

```ts
console.log(res.status);
```

### statusText

```ts
get statusText()
```

HTTP reason phrase.

May be empty for constructed responses.

```ts
console.log(res.statusText);
```

### headers

```ts
get headers()
```

Mutable response headers.

```ts
res.headers.set('content-type', 'application/json');
```

### body

```ts
get body(): ReadableStream | null
```

The body as a ReadableStream, or null if no body.
Returns the same stream on repeated access (spec: [SameObject]).

```ts
if (res.body !== null) for await (const chunk of res.body) console.log(chunk);
```

### bodyUsed

```ts
get bodyUsed()
```

True if the body has been read or the stream is locked.

```ts
if (!res.bodyUsed) console.log(await res.text());
```

### url

```ts
get url()
```

Final URL, empty for constructed responses and set by fetch clients.

```ts
console.log(res.url);
```

### type

```ts
get type()
```

Response type, currently `"default"` or `"error"`.

```ts
if (res.type === 'error') console.log('network error response');
```

### redirected

```ts
get redirected()
```

True if the response is the result of a redirect.

```ts
console.log(res.redirected);
```

### version

```ts
get version()
```

HTTP version string, a Fino extension for parsed wire responses.

```ts
console.log(res.version || 'constructed response');
```

### trailers

```ts
get trailers(): Promise<Headers>
```

Incoming trailer headers, resolving after a chunked body is fully consumed.

Constructed responses with outbound trailers resolve those trailers
immediately. Responses without trailers resolve an empty `Headers`.

```ts
const trailers = await res.trailers;
```

### text

```ts
async text()
```

Consume body and return as a UTF-8 string.

```ts
const text = await res.text();
```

### json

```ts
async json()
```

Consume body and parse as JSON.

Throws if the body was already consumed or JSON parsing fails.

```ts
const data = await res.json();
```

### arrayBuffer

```ts
async arrayBuffer()
```

Consume body and return as a copied ArrayBuffer.

```ts
const buffer = await res.arrayBuffer();
```

### bytes

```ts
async bytes()
```

Consume body and return as Uint8Array.

```ts
const bytes = await res.bytes();
```

### blob

```ts
async blob()
```

Consume body and return as a Blob.

The Blob type is derived from `content-type` when present.

```ts
const blob = await res.blob();
```

### clone

```ts
clone(): Response
```

Create an independent copy of this response.

Throws if the body is already consumed. Streaming bodies are teed; byte
bodies can be shared without copying.

```ts
const copy = res.clone();
```

### json

```ts
static json(data: unknown, init?: ResponseInit)
```

Create a Response with a JSON-serialised body and
Content-Type: application/json.

```ts
return Response.json({ ok: true }, { status: 201 });
```

### redirect

```ts
static redirect(url: string, status?: number)
```

Create a redirect Response.

The status must be one of 301, 302, 303, 307, or 308, otherwise a
`RangeError` is thrown.

```ts
return Response.redirect('/login', 302);
```

### error

```ts
static error()
```

Create a network error Response (type "error", status 0).

```ts
const res = Response.error();
console.log(res.type, res.status);
```

### from

```ts
static from(source: AsyncByteSource)
```

Parse an HTTP/1.x response from an async iterable of byte chunks
(e.g. a TCP connection).

```ts
const res = await Response.from(reader);
```

## parseRequest

```ts
async function parseRequest(source: AsyncIterable<Uint8Array | ArrayBuffer>): Promise<Request>
```

Parse an HTTP/1.x request from an async iterable of byte chunks.

The returned Request's `url` is constructed from the Host header and the
request path: "http://<host><path>".  If no Host header is present, `url`
contains only the path.

Throws on malformed request lines, malformed headers, conflicting
`Content-Length`, invalid chunked framing, or premature EOF.

```ts
const req = await parseRequest(reader);
```

## parseResponse

```ts
async function parseResponse(
  source: AsyncIterable<Uint8Array | ArrayBuffer>,
  method?: string
): Promise<Response>
```

Parse an HTTP response from a byte stream.

`method` is the original request method; pass `'HEAD'` so the parser knows
the response must not expose a body even if framing headers are present.
Throws on malformed status lines, headers, or body framing.

```ts
const res = await parseResponse(reader, request.method);
```

## _buildResponseHead

```ts
function _buildResponseHead(res: Response): string
```

Serialize HTTP response headers to a string (status-line + headers + CRLF).

Body bytes are not included. The version defaults to HTTP/1.1 when unset.

```ts
const head = _buildResponseHead(new Response('ok'));
```

## serializeResponse

```ts
async function* serializeResponse(res: Response, arena?: Arena): AsyncGenerator<Uint8Array>
```

Serialize a Response to an async iterable of Uint8Array chunks suitable for
piping to a TCP connection: status-line + headers first, then body chunks.

If outbound trailers are present, chunked transfer encoding is emitted and
`content-length` is removed from the wire headers. Reading from the returned
iterable consumes the response body.

```ts
for await (const chunk of serializeResponse(res, new Arena())) {
  await writer.write(chunk);
}
```

## serializeRequest

```ts
async function* serializeRequest(req: Request): AsyncGenerator<Uint8Array>
```

Serialize a Request to an async iterable of Uint8Array chunks suitable for
piping to a TCP connection: request-line + headers first, then body chunks.

Body framing:
  - No body → no framing headers added.
  - `content-length` already present → body emitted verbatim.
  - Body without content-length → `transfer-encoding: chunked` injected.

Reading from the returned iterable consumes the request body.

```ts
for await (const chunk of serializeRequest(req)) {
  await writer.write(chunk);
}
```

## connectionParser

```ts
function connectionParser(source: AsyncIterable<Uint8Array>): {
  parseNext(): Promise<Request>;
  parseBufferedNext(): Request | null;
}
```

Create a persistent HTTP/1.x request parser for a single connection.
Returns an object with a `parseNext()` method that parses one request at a
time from a shared buffered reader, preserving leftover bytes between
requests — required for correct keep-alive (pipelined) behavior.

Used by `fino:serve` so that multiple requests on the same TCP connection
share a single `_createReader` instance. Calling `parseRequest()` directly
would create a fresh reader each time and lose bytes between requests.

`parseBufferedNext()` returns `null` when a complete next request header is
not already buffered.

```ts
const parser = connectionParser(reader);
const req = await parser.parseNext();
```

## buildWireResponse

```ts
function buildWireResponse(
  {
    version,
    status,
    statusText,
    headers,
    body,
    url,
    redirected,
    outTrailers,
    inTrailers
  }: WireResponseInit
): Response
```

Build a Response from already-prepared wire components.
Used by `fino:serve` to inject `Connection` and `Content-Length` headers
and set the HTTP version without exposing the `INTERNAL` sentinel publicly.

Missing `version` defaults to HTTP/1.1, missing `status` defaults to 200, and
missing body becomes a bodyless response.

```ts
const wire = buildWireResponse({ headers: new Headers(), body: null, status: 204 });
```

## _concat

```ts
function _concat(parts: Uint8Array[], totalLen: number, arena?: Arena): Uint8Array
```

Concatenate an array of Uint8Array slices into a single Uint8Array.

When an arena is supplied, the returned bytes may be a view into arena
storage. Callers must consume it before resetting the arena.

```ts
const joined = _concat([a, b], a.byteLength + b.byteLength);
```
