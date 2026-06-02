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

## Intentional deviation from the Fetch spec

The WHATWG Fetch spec uses `ReadableStream` for response/request bodies.
Fino does not implement ReadableStream (it's a large, complex API). Instead,
`body` is an async iterable of `Uint8Array` chunks, which is simpler and
composable with `for await` loops and `writer.pipe()`.

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

### constructor

```ts
constructor(size: number = 8192)
```

### alloc

```ts
alloc(n: number): Uint8Array
```

### reset

```ts
reset(): void
```

## Headers

```ts
class Headers {
```

WHATWG-compatible Headers class.

Internal storage is an array of [name, value] pairs with lowercased names.
Iteration order is sorted ascending by name (per spec).

### constructor

```ts
constructor(init?: HeadersInit)
```

### append

```ts
append(name: string, value: string): void
```

Append a new value for the given header name.
If the header already exists, the new value is added alongside the old.

### _appendTrusted

```ts
_appendTrusted(name: string, value: string): void
```

Internal: append a pre-normalized [name, value] pair without validation.
name must already be lowercased and trimmed; value must already be trimmed
and free of control characters (guaranteed for wire-parsed headers).

### set

```ts
set(name: string, value: string): void
```

Set the value for a header name, replacing any existing values.

### get

```ts
get(name: string): string | null
```

Return the combined value for the given name, or null if not present.
Multiple values are joined with ", ".

### has

```ts
has(name: string): boolean
```

Return true if a header with the given name exists.

### delete

```ts
delete(name: string): void
```

Remove all values for the given header name.

### getSetCookie

```ts
getSetCookie()
```

Return an array of all Set-Cookie header values without joining.
Use this instead of get('set-cookie') to avoid value ambiguity.

### entries

```ts
entries()
```

Return an iterator over [name, value] pairs, sorted by name.

### keys

```ts
keys()
```

Return an iterator over header names, sorted.

### values

```ts
values()
```

Return an iterator over header values, sorted by name.

### forEach

```ts
forEach(callback: (value: string, name: string, headers: Headers) => void, thisArg?: unknown): void
```

Iterate over [name, value] pairs, sorted by name.

## _parseHeaders

```ts
function _parseHeaders(raw: Uint8Array): { firstLine: string; headers: Headers }
```

Parse a raw header block (everything up to and including "\r\n\r\n") into
a Headers instance.  Header names are lowercased; values are trimmed.

## Request

```ts
class Request {
```

Fetch API-compatible Request class.

Spec-style constructor: new Request(url, init?)
  url  — URL string or another Request
  init — { method?, headers?, body? }

Wire-parse constructor (internal): new Request(INTERNAL, { method, url, version, headers, body })

### constructor

```ts
constructor(input: string | Request | symbol, init?: RequestInit | any)
```

### trailers

```ts
get trailers(): Promise<Headers>
```

Incoming trailer headers — resolves after the chunked body is fully consumed.

### _hasOutTrailers

```ts
_hasOutTrailers(): boolean
```

### _getRawOutTrailers

```ts
_getRawOutTrailers(): OutTrailers | null
```

### url

```ts
get url()
```

The full URL string.

### method

```ts
get method()
```

HTTP method (uppercase).

### headers

```ts
get headers()
```

Request headers.

### body

```ts
get body(): ReadableStream | null
```

The body as a ReadableStream, or null if no body.
Returns the same stream on repeated access (spec: [SameObject]).

### bodyUsed

```ts
get bodyUsed()
```

True if the body has been read or the stream is locked.

### version

```ts
get version()
```

HTTP version string — fino extension (e.g. "HTTP/1.1").

### hasBody

```ts
get hasBody()
```

True if the request has a body.

### text

```ts
async text()
```

Consume body and return as a UTF-8 string.

### json

```ts
async json()
```

Consume body and parse as JSON.

### arrayBuffer

```ts
async arrayBuffer()
```

Consume body and return as ArrayBuffer.

### bytes

```ts
async bytes()
```

Consume body and return as Uint8Array.

### blob

```ts
async blob()
```

Consume body and return as a Blob.

### clone

```ts
clone(): Request
```

Create an independent copy of this request.

### from

```ts
static from(source: AsyncByteSource)
```

Parse an HTTP/1.x request from an async iterable of byte chunks
(e.g. a TCP connection).

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

### constructor

```ts
constructor(body: BodyInit | symbol, init?: ResponseInit | any)
```

### ok

```ts
get ok()
```

True if status is in the 200–299 range.

### status

```ts
get status()
```

HTTP status code.

### statusText

```ts
get statusText()
```

HTTP reason phrase.

### headers

```ts
get headers()
```

Response headers.

### body

```ts
get body(): ReadableStream | null
```

The body as a ReadableStream, or null if no body.
Returns the same stream on repeated access (spec: [SameObject]).

### bodyUsed

```ts
get bodyUsed()
```

True if the body has been read or the stream is locked.

### url

```ts
get url()
```

Final URL (empty for constructed responses; set by fetch clients).

### type

```ts
get type()
```

Response type — always "default" or "error".

### redirected

```ts
get redirected()
```

True if the response is the result of a redirect.

### version

```ts
get version()
```

HTTP version string — fino extension (e.g. "HTTP/1.1").

### trailers

```ts
get trailers(): Promise<Headers>
```

Incoming trailer headers — resolves after the chunked body is fully consumed.

### _hasOutTrailers

```ts
_hasOutTrailers(): boolean
```

### _getRawOutTrailers

```ts
_getRawOutTrailers(): OutTrailers | null
```

### _getOutTrailers

```ts
async _getOutTrailers(): Promise<Headers>
```

### text

```ts
async text()
```

Consume body and return as a UTF-8 string.

### json

```ts
async json()
```

Consume body and parse as JSON.

### arrayBuffer

```ts
async arrayBuffer()
```

Consume body and return as ArrayBuffer.

### bytes

```ts
async bytes()
```

Consume body and return as Uint8Array.

### blob

```ts
async blob()
```

Consume body and return as a Blob.

### clone

```ts
clone(): Response
```

Create an independent copy of this response.

### json

```ts
static json(data: unknown, init?: ResponseInit)
```

Create a Response with a JSON-serialised body and
Content-Type: application/json.

### redirect

```ts
static redirect(url: string, status?: number)
```

Create a redirect Response.

### error

```ts
static error()
```

Create a network error Response (type "error", status 0).

### from

```ts
static from(source: AsyncByteSource)
```

Parse an HTTP/1.x response from an async iterable of byte chunks
(e.g. a TCP connection).

## parseRequest

```ts
async function parseRequest(source: AsyncIterable<Uint8Array | ArrayBuffer>): Promise<Request>
```

Parse an HTTP/1.x request from an async iterable of byte chunks.

The returned Request's `url` is constructed from the Host header and the
request path: "http://<host><path>".  If no Host header is present, `url`
contains only the path.

## parseResponse

```ts
async function parseResponse( source: AsyncIterable<Uint8Array | ArrayBuffer>, method?: string, ): Promise<Response>
```

Parse an HTTP response from a byte stream.

                  must never have a body even when Content-Length is present.

## _buildResponseHead

```ts
function _buildResponseHead(res: Response): string
```

Serialize HTTP response headers to a string (status-line + headers + CRLF).

## serializeResponse

```ts
async function* serializeResponse(res: Response, arena?: Arena): AsyncGenerator<Uint8Array>
```

Serialize a Response to an async iterable of Uint8Array chunks suitable for
piping to a TCP connection: status-line + headers first, then body chunks.

  bytes and chunked framing are allocated from the arena (zero extra alloc).

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

## connectionParser

```ts
function connectionParser(source: AsyncIterable<Uint8Array>): { parseNext(): Promise<Request>, parseBufferedNext(): Request | null }
```

Create a persistent HTTP/1.x request parser for a single connection.
Returns an object with a `parseNext()` method that parses one request at a
time from a shared buffered reader, preserving leftover bytes between
requests — required for correct keep-alive (pipelined) behavior.

Used by `fino:serve` so that multiple requests on the same TCP connection
share a single `_createReader` instance. Calling `parseRequest()` directly
would create a fresh reader each time and lose bytes between requests.

## buildWireResponse

```ts
function buildWireResponse({ version, status, statusText, headers, body, url, redirected, outTrailers, inTrailers }: WireResponseInit): Response
```

Build a Response from already-prepared wire components.
Used by `fino:serve` to inject `Connection` and `Content-Length` headers
and set the HTTP version without exposing the `INTERNAL` sentinel publicly.

## _iterableFromBytes

```ts
function _iterableFromBytes(bytes: Uint8Array): AsyncByteIterable
```

Wrap a Uint8Array as a single-chunk async iterable.

## _concat

```ts
function _concat(parts: Uint8Array[], totalLen: number, arena?: Arena): Uint8Array
```

Concatenate an array of Uint8Array slices into a single Uint8Array.
