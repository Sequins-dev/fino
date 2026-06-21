/**
 * fino:net/http/eventsource — Server-Sent Events (SSE) client and server.
 *
 * Implements the SSE wire protocol (W3C EventSource spec) in two composable
 * layers, following the same thin-primitive philosophy as Fino streams and
 * HTTP wire helpers.
 *
 *
 * ## EventSourceReader (composable parser primitive)
 *
 * Wraps any async iterable of byte chunks and yields parsed SSE events.
 * No connection or reconnection logic — purely a wire-format parser, analogous
 * to how `parseResponse()` consumes a byte stream.
 *
 * ```ts no_run
 *   import { EventSourceReader } from './eventsource.mts';
 *
 *   const reader = new EventSourceReader(response.body);
 *   for await (const event of reader) {
 *     // event: { type, data, id, retry }
 *   }
 *   reader.lastEventId; // persists across all events in the stream
 * ```
 *
 *
 * ## EventSourceWriter (composable formatter primitive)
 *
 * Formats and writes SSE events to any Writer (from fino:stream).
 * Server-side counterpart to EventSourceReader.
 *
 * ```ts no_run
 *   import { EventSourceWriter } from './eventsource.mts';
 *
 *   const esw = new EventSourceWriter(writer);
 *   await esw.event({ data: 'hello' });
 *   await esw.event({ event: 'update', data: 'multi\nline', id: '42' });
 *   await esw.comment('keep-alive');
 *   await esw.retry(5000);
 * ```
 *
 *
 * ## EventSource (server-side SSE client)
 *
 * Runtime EventSource with connection management, automatic reconnection with
 * Last-Event-ID resumption, and EventTarget-based event dispatch. Extends
 * EventTarget so `addEventListener` / `removeEventListener` work as expected.
 *
 * The client opens direct HTTP/1 socket or TLS connections and parses the SSE
 * wire stream itself. It intentionally does not share the `fetch()` connection
 * pool or provide HTTP/2 or HTTP/3 transport behavior in this release baseline.
 *
 * ```ts no_run
 *   import { EventSource } from './eventsource.mts';
 *
 *   const es = new EventSource('http://localhost:3000/events');
 *   es.onopen    = () => { ... };
 *   es.onmessage = (e) => { console.log(e.data); };
 *   es.onerror   = (e) => { ... };
 *   es.addEventListener('update', (e) => { ... });
 *   // later:
 *   es.close();
 * ```
 *
 *
 * ## SSE wire format
 *
 * Each event is one or more field lines followed by a blank line:
 *   event: <type>\n       ← optional; defaults to "message"
 *   data: <line1>\n
 *   data: <line2>\n       ← multi-line data: joined with "\n"
 *   id: <id>\n            ← optional; updates lastEventId buffer
 *   retry: <ms>\n         ← optional; integer ms reconnection interval
 *   \n                    ← blank line dispatches the event
 *
 * Lines starting with `:` are comments (ignored). Unknown field names are
 * ignored. Line terminators: LF, CRLF, or bare CR (per W3C spec).
 *
 *
 * ## EventSourceReader parser rules (W3C spec)
 *
 * - `id:` field value must not contain null (U+0000); otherwise ignored.
 * - `retry:` value must be all ASCII digits; otherwise ignored.
 * - An empty `id:` field (i.e. `id:\n`) sets lastEventId to "".
 * - Events without any `data:` lines are not dispatched.
 * - A field name with no colon means the entire line is the field name and
 *   the value is empty string.
 * - A single leading space after the colon is stripped from field values.
 *
 *
 * ## EventSource reconnection (W3C spec + pragmatic additions)
 *
 * - Reconnects on: EOF (stream ended normally), network errors, and HTTP
 *   status codes 429, 500, 502, 503, 504 (retriable errors).
 * - Follows local HTTP redirects for 301, 302, 303, 307, and 308 responses,
 *   resolving relative `Location` values against the current request URL.
 *   Redirects always remain GET requests and are capped to prevent loops.
 * - Does NOT reconnect on: wrong Content-Type, other HTTP error statuses.
 * - HTTP 204 closes the stream gracefully without reconnecting.
 * - Reconnection uses a configurable retry interval (default: 3000ms),
 *   updated dynamically by `retry:` fields in the event stream.
 * - The `Last-Event-ID` header is sent on every reconnect attempt if
 *   a non-empty last event ID has been seen.
 *
 * ## Credentials, CORS, and TLS
 *
 * This is a server-side EventSource implementation. It supports explicit
 * caller-provided headers for credentials such as bearer tokens, but it does
 * not implement browser cookie credential modes, an implicit cookie jar, or
 * browser CORS enforcement. `Set-Cookie` response headers are ignored; callers
 * that need cookies must provide a `Cookie` header explicitly. TLS verification
 * is enabled by default for `https:` URLs. Tests and private deployments may
 * pass a pinned CA path through `tls.ca`; disabling certificate verification
 * with `tls.rejectUnauthorized: false` should be limited to local development.
 *
 *
 * ## Contributing
 *
 * - EventSourceReader is a single-use async iterator — do not call
 *   `[Symbol.asyncIterator]()` more than once on the same instance.
 * - EventSourceWriter does not own the Writer; callers are responsible
 * ```ts no_run
 *   for closing it.
 * ```
 * - EventSource connects immediately upon construction.
 * - Keep EventSourceReader and EventSourceWriter free of connection logic.
 *   Network concerns belong in EventSource only.
 */

import { decodeUtf8, encodeUtf8 } from '../../internal/globals/encoding.mts';
import { Headers, parseResponse } from './index.mts';
import { Socket } from '../socket.mts';
import { TlsSocket } from '../tls.mts';
import { lookup } from '../dns.mts';
import * as loop from '../../internal/runtime/loop.mts';
import { EventTarget, Event } from '../../internal/globals/eventtarget.mts';
import { MessageEvent } from '../../internal/globals/messaging.mts';
import { URL } from '../../internal/globals/url.mts';
import type { Address, IPv4Address, IPv6Address } from '../socket.mts';

/**
 * Parsed server-sent event yielded by `EventSourceReader`.
 *
 * Events without `data:` fields are not yielded. `id` and `retry` are `null`
 * when the event did not include those fields.
 *
 * ```ts no_run
 * for await (const event of new EventSourceReader(body)) console.log(event.type, event.data);
 * ```
 */
export interface SseEvent {
  /** Event type; defaults to `"message"` when the stream omits `event:`.
   *
   * ```ts no_run
   * if (event.type === 'message') console.log(event.data);
   * ```
   */
  type:  string;
  /** Event payload with multiple `data:` lines joined by newline.
   *
   * ```ts no_run
   * console.log(event.data);
   * ```
   */
  data:  string;
  /** Event ID from `id:`, or `null` when absent.
   *
   * ```ts no_run
   * if (event.id !== null) console.log(event.id);
   * ```
   */
  id:    string | null;
  /** Retry interval from `retry:`, or `null` when absent or invalid.
   *
   * ```ts no_run
   * if (event.retry !== null) console.log(event.retry);
   * ```
   */
  retry: number | null;
}

/**
 * Options for the EventSource client connection.
 *
 * Headers are sent on the initial request and reconnect attempts. The client
 * also adds `Last-Event-ID` during reconnect when an ID has been seen.
 *
 * ```ts no_run
 * const es = new EventSource('https://example.com/events', {
 *   headers: { authorization: 'Bearer token' },
 * });
 * ```
 */
export interface EventSourceInit {
  /** Extra HTTP headers for the SSE request.
   *
   * ```ts no_run
   * new EventSource(url, { headers: new Headers({ authorization: 'Bearer t' }) });
   * ```
   */
  headers?: Record<string, string> | Headers;
  /** TLS trust options for `https:` EventSource connections.
   *
   * `rejectUnauthorized` defaults to `true`; `ca` points at a PEM CA file.
   * These options are ignored for `http:` URLs.
   *
   * ```ts no_run
   * new EventSource('https://localhost/events', { tls: { ca: '/tmp/test-ca.pem' } });
   * ```
   */
  tls?: {
    ca?: string;
    rejectUnauthorized?: boolean;
  };
}

interface SseEventOptions {
  data:    string;
  event?:  string;
  id?:     string;
  retry?:  number;
}

interface WriterLike {
  write(data: Uint8Array): Promise<number>;
}

interface ClosableAsyncByteReader extends AsyncIterable<Uint8Array | ArrayBuffer> {
  close(): void;
}

// ---------------------------------------------------------------------------
// EventSourceReader — SSE parser (composable primitive)
// ---------------------------------------------------------------------------

/**
 * Parses an SSE byte stream into discrete events.
 *
 * Accepts any async iterable of Uint8Array/ArrayBuffer chunks — e.g. a Reader
 * from Fino streams or an HTTP response body.
 *
 * Implements `[Symbol.asyncIterator]` for `for await` consumption.
 *
 * ```ts no_run
 * const reader = new EventSourceReader(response.body);
 * for await (const event of reader) {
 *   console.log(event.type, event.data);
 * }
 * ```
 */
export class EventSourceReader {
  /**
   * Private property `#source` used by `EventSourceReader`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #source = undefined;
   *
   *   readInternalState() {
   *     return this.#source;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #source: AsyncIterable<Uint8Array | ArrayBuffer>;
  /**
   * Private property `#lastEventId` used by `EventSourceReader`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #lastEventId = undefined;
   *
   *   readInternalState() {
   *     return this.#lastEventId;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #lastEventId: string;

  /**
   * Create an SSE parser over a byte stream.
   *
   * The parser is single-use because it consumes the source iterator as it
   * yields events.
   *
   * ```ts no_run
   * const reader = new EventSourceReader(response.body);
   * ```
   */
  constructor(source: AsyncIterable<Uint8Array | ArrayBuffer>) {
    this.#source      = source;
    this.#lastEventId = '';
  }

  /**
   * The last event ID seen in the stream. Updated as events are yielded,
   * so it reflects the ID of the most recently yielded event that had an
   * `id:` field. Persists across all events in the stream.
   *
   * ```ts no_run
   * console.log(reader.lastEventId);
   * ```
   */
  get lastEventId() { return this.#lastEventId; }

  /**
   * Iterate over parsed SSE events.
   *
   * Each yielded value is a plain object:
   *   {
   *     type:  string        — event type (defaults to "message")
   *     data:  string        — payload (multi-line joined with "\n")
   *     id:    string|null   — event id field value, or null if absent
   *     retry: number|null   — retry ms, or null if absent
   *   }
   *
   * ```ts no_run
   * for await (const event of reader) console.log(event);
   * ```
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<SseEvent> {
    let eventType = '';
    let data: string[] = [];
    let eventId: string | null = null;   // null = no id: field in this event
    let hasData   = false;  // true if at least one data: field was seen
    let retry: number | null = null;

    for await (const line of _lines(this.#source)) {
      // Blank line = dispatch event
      if (line === '') {
        if (hasData) {
          // Update lastEventId buffer when id: field was present
          if (eventId !== null) this.#lastEventId = eventId;

          yield {
            type:  eventType || 'message',
            data:  data.join('\n'),
            id:    eventId,
            retry,
          };
        }
        // Reset for next event
        eventType = '';
        data      = [];
        eventId   = null;
        hasData   = false;
        retry     = null;
        continue;
      }

      // Comment line — skip
      if (line.charCodeAt(0) === 0x3A) continue; // ':'

      // Parse field: value
      const colonIdx = line.indexOf(':');
      let field: string;
      let value: string;
      if (colonIdx === -1) {
        field = line;
        value = '';
      } else {
        field = line.substring(0, colonIdx);
        // Strip one leading space after colon per spec
        const vStart = colonIdx + 1;
        value = (vStart < line.length && line.charCodeAt(vStart) === 0x20)
          ? line.substring(vStart + 1)
          : line.substring(vStart);
      }

      if (field === 'data') {
        data.push(value);
        hasData = true;
      } else if (field === 'event') {
        eventType = value;
      } else if (field === 'id') {
        // Per spec: ignored if value contains U+0000 NULL
        if (!value.includes('\0')) eventId = value;
      } else if (field === 'retry') {
        // Per spec: must be all ASCII digits
        if (/^\d+$/.test(value)) retry = parseInt(value, 10);
      }
      // Unknown fields are ignored per spec
    }

    // Dispatch any trailing event (stream ended without trailing blank line)
    if (hasData) {
      if (eventId !== null) this.#lastEventId = eventId;
      yield {
        type:  eventType || 'message',
        data:  data.join('\n'),
        id:    eventId,
        retry,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// EventSourceWriter — SSE formatter (composable primitive)
// ---------------------------------------------------------------------------

/**
 * Formats and writes SSE events to a Writer.
 *
 * The writer must have an async `write(Uint8Array)` method compatible with
 * the Writer interface from fino:stream.
 *
 * ```ts no_run
 * const esw = new EventSourceWriter(writer);
 * await esw.event({ data: 'hello' });
 * await esw.event({ event: 'update', data: 'line1\nline2', id: '42' });
 * await esw.comment('keep-alive');
 * await esw.retry(5000);
 * ```
 */
export class EventSourceWriter {
  /**
   * Private property `#writer` used by `EventSourceWriter`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #writer = undefined;
   *
   *   readInternalState() {
   *     return this.#writer;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #writer: WriterLike;

  /**
   * Create an SSE writer around a byte writer.
   *
   * The writer is not closed by this class. Callers are responsible for flush
   * and close behavior if their writer requires it.
   *
   * ```ts no_run
   * const events = new EventSourceWriter(writer);
   * ```
   */
  constructor(writer: WriterLike) {
    this.#writer = writer;
  }

  /**
   * Write an SSE event.
   *
   * Multi-line `data` strings are automatically split into separate `data:`
   * lines. All fields are optional except `data`.
   *
   * `retry` is floored to an integer. Field values are stringified but not
   * escaped, so do not include untrusted newlines in `event` or `id`.
   *
   * ```ts no_run
   * await events.event({ event: 'update', data: 'line 1\\nline 2', id: '42' });
   * ```
   */
  async event(opts: SseEventOptions): Promise<void> {
    let frame = '';

    if (opts.event !== undefined && opts.event !== null) {
      frame += 'event: ' + String(opts.event) + '\n';
    }

    // Multi-line data: split into separate data: lines
    const lines = String(opts.data).split('\n');
    for (const line of lines) {
      frame += 'data: ' + line + '\n';
    }

    if (opts.id !== undefined && opts.id !== null) {
      frame += 'id: ' + String(opts.id) + '\n';
    }

    if (opts.retry !== undefined && opts.retry !== null) {
      frame += 'retry: ' + Math.floor(Number(opts.retry)) + '\n';
    }

    frame += '\n'; // blank line terminates the event
    await this.#writer.write(encodeUtf8(frame));
  }

  /**
   * Write a comment line. Useful for keep-alive heartbeats that prevent
   * proxies from closing idle connections.
   *
   * Multi-line comments are emitted as multiple comment lines.
   *
   * ```ts no_run
   * await events.comment('heartbeat');
   * ```
   */
  async comment(text: string = ''): Promise<void> {
    let frame = '';
    const lines = String(text).split('\n');
    for (const line of lines) {
      frame += ': ' + line + '\n';
    }
    frame += '\n';
    await this.#writer.write(encodeUtf8(frame));
  }

  /**
   * Write a standalone `retry:` field to update the client's reconnection
   * interval without dispatching an event.
   *
   * The value is floored to an integer number of milliseconds.
   *
   * ```ts no_run
   * await events.retry(5000);
   * ```
   */
  async retry(ms: number): Promise<void> {
    await this.#writer.write(encodeUtf8('retry: ' + Math.floor(Number(ms)) + '\n\n'));
  }
}

// ---------------------------------------------------------------------------
// EventSource — spec-compliant SSE client
// ---------------------------------------------------------------------------

const CONNECTING = 0;
const OPEN       = 1;
const CLOSED     = 2;

/** HTTP status codes that trigger reconnection rather than permanent failure. */
const RETRIABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
/** HTTP redirect statuses followed by the client before opening the stream. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Redirect cap for one connection attempt. */
const MAX_REDIRECTS = 20;

/** Default reconnection interval per W3C spec (3 seconds). */
const DEFAULT_RETRY_MS = 3000;

/**
 * W3C EventSource — a spec-compliant SSE client.
 *
 * Manages its own HTTP connection (plain or TLS), handles reconnection with
 * exponential retry intervals, resumes from the last event ID, and dispatches
 * events through the EventTarget interface.
 *
 *
 * ```ts no_run
 * loop.run(async () => {
 *   const es = new EventSource('http://localhost:3000/events');
 *   es.onmessage = (e) => console.log(e.data);
 *   await someShutdownSignal;
 *   es.close();
 * });
 * ```
 */
export class EventSource extends EventTarget {
  /** Ready state value while connecting or reconnecting.
   *
   * ```ts no_run
   * if (es.readyState === EventSource.CONNECTING) console.log('connecting');
   * ```
   */
  static CONNECTING = CONNECTING;
  /** Ready state value while the stream is open.
   *
   * ```ts no_run
   * if (es.readyState === EventSource.OPEN) console.log('open');
   * ```
   */
  static OPEN       = OPEN;
  /** Ready state value after `close()` or terminal failure.
   *
   * ```ts no_run
   * if (es.readyState === EventSource.CLOSED) console.log('closed');
   * ```
   */
  static CLOSED     = CLOSED;

  /**
   * Private property `#url` used by `EventSource`.
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
   * Private property `#readyState` used by `EventSource`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #readyState = undefined;
   *
   *   readInternalState() {
   *     return this.#readyState;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #readyState: number;
  // null = no id: field ever received; '' = empty id: field received.
  // The distinction matters for Last-Event-ID: an empty id should still be
  // sent on reconnect (with an empty value) per the WHATWG EventSource spec.
  /**
   * Private property `#lastEventId` used by `EventSource`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #lastEventId = undefined;
   *
   *   readInternalState() {
   *     return this.#lastEventId;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #lastEventId: string | null;
  /**
   * Private property `#retryInterval` used by `EventSource`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #retryInterval = undefined;
   *
   *   readInternalState() {
   *     return this.#retryInterval;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #retryInterval: number;
  /**
   * Private property `#extraHeaders` used by `EventSource`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #extraHeaders = undefined;
   *
   *   readInternalState() {
   *     return this.#extraHeaders;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #extraHeaders: Headers;
  #tlsOptions: EventSourceInit['tls'] | undefined;
  /**
   * Private property `#currentReader` used by `EventSource`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #currentReader = undefined;
   *
   *   readInternalState() {
   *     return this.#currentReader;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #currentReader: { close(): void } | null;   // FdReader — set during an active connection; used to abort reads on close()
  /**
   * Private property `#onopen` used by `EventSource`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #onopen = undefined;
   *
   *   readInternalState() {
   *     return this.#onopen;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #onopen: ((e: Event) => void) | null;
  /**
   * Private property `#onmessage` used by `EventSource`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #onmessage = undefined;
   *
   *   readInternalState() {
   *     return this.#onmessage;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #onmessage: ((e: MessageEvent) => void) | null;
  /**
   * Private property `#onerror` used by `EventSource`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #onerror = undefined;
   *
   *   readInternalState() {
   *     return this.#onerror;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #onerror: ((e: Event) => void) | null;

  /**
   * Create and immediately start an SSE client.
   *
   * Only `http:` and `https:` URLs are supported. Connection errors dispatch
   * `error` and reconnect for retriable statuses unless `close()` is called.
   *
   * ```ts no_run
   * const es = new EventSource('https://example.com/events');
   * es.onmessage = (event) => console.log(event.data);
   * ```
   */
  constructor(url: string, init?: EventSourceInit) {
    super();
    this.#url           = String(url);
    this.#readyState    = CONNECTING;
    this.#lastEventId   = null;
    this.#retryInterval = DEFAULT_RETRY_MS;
    this.#extraHeaders  = init?.headers ? new Headers(init.headers) : new Headers();
    this.#tlsOptions    = init?.tls;
    this.#currentReader = null;
    this.#onopen        = null;
    this.#onmessage     = null;
    this.#onerror       = null;

    // Kick off the connection loop. Errors are handled internally.
    this.#run().catch(function swallowEvtSrcErr() {});
  }

  /** Current ready state: CONNECTING (0), OPEN (1), or CLOSED (2).
   *
   * ```ts no_run
   * console.log(es.readyState);
   * ```
   */
  get readyState() { return this.#readyState; }

  /** The URL passed to the constructor.
   *
   * ```ts no_run
   * console.log(es.url);
   * ```
   */
  get url() { return this.#url; }

  /** The last event ID received from the server.
   *
   * Sent as `Last-Event-ID` on reconnect. Returns an empty string before any
   * `id:` field is received.
   *
   * ```ts no_run
   * console.log(es.lastEventId);
   * ```
   */
  get lastEventId() { return this.#lastEventId ?? ''; }

  /** Callback for `open` events (connection established).
   *
   * ```ts no_run
   * es.onopen = () => console.log('open');
   * ```
   */
  get onopen()    { return this.#onopen; }
  /** Set the `open` event callback, or `null` to clear it.
   *
   * ```ts no_run
   * es.onopen = null;
   * ```
   */
  set onopen(fn: ((e: Event) => void) | null)  { this.#onopen = typeof fn === 'function' ? fn : null; }

  /** Callback for `message` events (default-type SSE events).
   *
   * ```ts no_run
   * es.onmessage = (event) => console.log(event.data);
   * ```
   */
  get onmessage()   { return this.#onmessage; }
  /** Set the `message` event callback, or `null` to clear it.
   *
   * ```ts no_run
   * es.onmessage = null;
   * ```
   */
  set onmessage(fn: ((e: MessageEvent) => void) | null) { this.#onmessage = typeof fn === 'function' ? fn : null; }

  /** Callback for `error` events (connection errors and fatal failures).
   *
   * ```ts no_run
   * es.onerror = () => console.log('stream error');
   * ```
   */
  get onerror()   { return this.#onerror; }
  /** Set the `error` event callback, or `null` to clear it.
   *
   * ```ts no_run
   * es.onerror = null;
   * ```
   */
  set onerror(fn: ((e: Event) => void) | null) { this.#onerror = typeof fn === 'function' ? fn : null; }

  /**
   * Close the connection and prevent any further reconnection.
   * Idempotent — safe to call multiple times.
   *
   * ```ts no_run
   * es.close();
   * ```
   */
  close() {
    if (this.#readyState === CLOSED) return;
    this.#readyState = CLOSED;
    // Closing the reader (if active) causes the next read() to return null,
    // which terminates the body iterator and unwinds the connection loop.
    if (this.#currentReader) {
      try { this.#currentReader.close(); } catch (_) {}
      this.#currentReader = null;
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  // ---------------------------------------------------------------------------
  // Internal: connection and reconnection loop
  // ---------------------------------------------------------------------------

  /**
   * Private method `#run` used by `EventSource`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #run() {
   *     return 'run';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#run();
   *   }
   * }
   * ```
   *
   * @internal
   */
  async #run() {
    while (this.#readyState !== CLOSED) {
      this.#readyState = CONNECTING;
      let sock: Socket | TlsSocket | null = null;
      let reader: ClosableAsyncByteReader | null = null;

      try {
        let requestUrl = this.#url;
        let redirectCount = 0;
        let response: Awaited<ReturnType<typeof parseResponse>>;
        let origin = '';

        while (true) {
          // ---- Parse URL ------------------------------------------------------
          const parsed  = new URL(requestUrl);
          const isHttps = parsed.protocol === 'https:';
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('EventSource URL must use http: or https:');
          }
          const hostname = parsed.hostname;
          const port = parsed.port
            ? parseInt(parsed.port, 10)
            : (isHttps ? 443 : 80);
          const path = (parsed.pathname + parsed.search) || '/';
          origin = parsed.origin;

          // ---- DNS lookup -----------------------------------------------------
          const { address, family } = await lookup(hostname);
          if (this.#readyState === CLOSED) return;

          const addr: IPv4Address | IPv6Address = family === 6
            ? { family: 'ipv6', ip: address, port }
            : { family: 'ipv4', ip: address, port };

          // ---- TCP / TLS connect ----------------------------------------------
          if (isHttps) {
            sock = await TlsSocket.connect(addr, {
              hostname,
              ca: this.#tlsOptions?.ca,
              rejectUnauthorized: this.#tlsOptions?.rejectUnauthorized,
            });
          } else {
            sock = await Socket.connect(addr);
          }
          if (this.#readyState === CLOSED) { _closeSocket(sock); return; }

          // ---- Split and register reader for close() cancellation -------------
          const [r, writer] = sock.split();
          reader = r;
          this.#currentReader = reader;

          // ---- Build and send HTTP request ------------------------------------
          const headers = new Headers(this.#extraHeaders);
          headers.set('accept', 'text/event-stream');
          headers.set('cache-control', 'no-store');
          if (this.#lastEventId !== null) {
            headers.set('last-event-id', this.#lastEventId);
          }
          const hostHeader = parsed.port
            ? `${hostname}:${parsed.port}`
            : hostname;

          let reqStr = `GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\n`;
          for (const [name, value] of headers) {
            reqStr += `${name}: ${value}\r\n`;
          }
          reqStr += '\r\n';

          await _writeToSocket(writer, encodeUtf8(reqStr));
          if (this.#readyState === CLOSED) return;

          // ---- Parse HTTP response headers -----------------------------------
          response = await parseResponse(reader);
          if (this.#readyState === CLOSED) return;

          if (!REDIRECT_STATUSES.has(response.status)) break;

          const location = response.headers.get('location');
          if (location === null) {
            this.#readyState = CLOSED;
            this.#fireError();
            return;
          }
          if (++redirectCount > MAX_REDIRECTS) {
            this.#readyState = CLOSED;
            this.#fireError();
            return;
          }

          requestUrl = new URL(location, parsed.href).href;
          if (this.#currentReader === reader) this.#currentReader = null;
          reader = null;
          _closeSocket(sock);
          sock = null;
        }

        const status = response.status;
        const ct     = response.headers.get('content-type') ?? '';

        // ---- HTTP 204: graceful server-side close ----------------------------
        if (status === 204) {
          this.#readyState = CLOSED;
          return;
        }

        // ---- Retriable server error (429, 5xx) --------------------------------
        if (RETRIABLE_STATUSES.has(status)) {
          this.#fireError();
          if (this.#readyState === CLOSED) return;
          await loop.timeout(this.#retryInterval);
          continue;
        }

        // ---- Fatal: wrong status or content-type -----------------------------
        if (status !== 200 || !ct.includes('text/event-stream')) {
          this.#readyState = CLOSED;
          this.#fireError();
          return;
        }

        // ---- Connection established — begin reading events -------------------
        this.#readyState = OPEN;
        this.#fireOpen(origin);
        if (this.#readyState === CLOSED) return;

        // Feed the response body through the SSE parser. The body is an async
        // iterable of byte chunks from the socket (EOF-delimited per HTTP rules).
        if (response.body === null) {
          this.#readyState = CONNECTING;
          this.#fireError();
          await loop.timeout(this.#retryInterval);
          continue;
        }
        const esReader = new EventSourceReader(response.body);
        for await (const event of esReader) {
          if (this.#readyState === CLOSED) return;

          // Server-side retry interval update
          if (event.retry !== null) this.#retryInterval = event.retry;

          // Persist last event ID (EventSourceReader already validated it)
          if (event.id !== null) this.#lastEventId = event.id;

          this.#fireMessage(event, origin);
        }

        // ---- Normal EOF: server closed the stream — reconnect per spec -------
        if (this.#readyState === CLOSED) return;
        this.#readyState = CONNECTING;
        this.#fireError();
        await loop.timeout(this.#retryInterval);

      } catch (_err) {
        // ---- Network / connection error: reconnect ---------------------------
        if (this.#readyState === CLOSED) return;
        this.#readyState = CONNECTING;
        this.#fireError();
        await loop.timeout(this.#retryInterval);

      } finally {
        // Clean up the current reader reference; close socket if still open.
        if (this.#currentReader === reader) this.#currentReader = null;
        if (sock !== null) {
          try { _closeSocket(sock); } catch (_) {}
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: event dispatching
  // ---------------------------------------------------------------------------

  /**
   * Private method `#fireOpen` used by `EventSource`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #fireOpen() {
   *     return 'fireOpen';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#fireOpen();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #fireOpen(origin: string) {
    const e = new Event('open');
    this.dispatchEvent(e);
    if (this.#onopen) this.#onopen.call(this, e);
  }

  /**
   * Private method `#fireMessage` used by `EventSource`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #fireMessage() {
   *     return 'fireMessage';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#fireMessage();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #fireMessage(event: SseEvent, origin: string) {
    const e = new MessageEvent(event.type, {
      data:        event.data,
      lastEventId: this.#lastEventId,
      origin,
    });
    this.dispatchEvent(e);
    if (event.type === 'message' && this.#onmessage) {
      this.#onmessage.call(this, e);
    }
  }

  /**
   * Private method `#fireError` used by `EventSource`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #fireError() {
   *     return 'fireError';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#fireError();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #fireError() {
    const e = new Event('error');
    this.dispatchEvent(e);
    if (this.#onerror) this.#onerror.call(this, e);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Write bytes to a socket writer and flush the coalesce buffer to the wire.
 *
 * @param {{ write(data: Uint8Array): Promise<void>; flush(): Promise<void> }} writer
 * @param {Uint8Array} bytes
 */
async function _writeToSocket(writer: { write(data: Uint8Array): Promise<void>; flush(): Promise<void> }, bytes: Uint8Array): Promise<void> {
  await writer.write(bytes);
  await writer.flush();
}

/**
 * Close a Socket or TlsSocket, suppressing errors.
 * @param {{ closed: boolean, close(): void }} sock
 */
function _closeSocket(sock: { closed: boolean; close(): void }): void {
  if (sock && !sock.closed) sock.close();
}


/**
 * Split an async byte stream into text lines.
 *
 * Recognizes LF (\n), CRLF (\r\n), and bare CR (\r) as line terminators
 * per the W3C SSE specification. Terminators are stripped from yielded values.
 * Handles terminators split across chunk boundaries.
 *
 * @param {AsyncIterable<Uint8Array|ArrayBuffer>} source
 * @yields {string} — one line per yield, terminators stripped
 */
async function* _lines(source: AsyncIterable<Uint8Array | ArrayBuffer>): AsyncGenerator<string> {
  let buf = ''; // partial line from previous chunk

  for await (const chunk of source) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    buf += decodeUtf8(bytes);

    let start = 0;
    let i     = 0;
    while (i < buf.length) {
      const ch = buf.charCodeAt(i);
      if (ch === 0x0A) { // LF
        yield buf.substring(start, i);
        i++;
        start = i;
      } else if (ch === 0x0D) { // CR
        yield buf.substring(start, i);
        i++;
        // CR followed immediately by LF = CRLF (single terminator)
        if (i < buf.length && buf.charCodeAt(i) === 0x0A) i++;
        start = i;
      } else {
        i++;
      }
    }

    // Keep any partial line (no terminator yet) for the next chunk
    buf = start < buf.length ? buf.substring(start) : '';
  }

  // Yield any remaining data as the last line (no trailing newline)
  if (buf.length > 0) yield buf;
}
