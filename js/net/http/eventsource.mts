/**
 * fino:net/http/eventsource — Server-Sent Events (SSE) client and server.
 *
 * Implements the SSE wire protocol (W3C EventSource spec) in two composable
 * layers, following the same thin-primitive philosophy as fino:stream and
 * fino:http.
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
 * ## EventSource (spec-compliant SSE client)
 *
 * Full W3C EventSource with connection management, automatic reconnection with
 * Last-Event-ID resumption, and EventTarget-based event dispatch. Extends
 * EventTarget so `addEventListener` / `removeEventListener` work as expected.
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
 * - Does NOT reconnect on: wrong Content-Type, other HTTP error statuses.
 * - HTTP 204 closes the stream gracefully without reconnecting.
 * - Reconnection uses a configurable retry interval (default: 3000ms),
 *   updated dynamically by `retry:` fields in the event stream.
 * - The `Last-Event-ID` header is sent on every reconnect attempt if
 *   a non-empty last event ID has been seen.
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

/** Parsed server-sent event yielded by `EventSourceReader`. */
export interface SseEvent {
  type:  string;
  data:  string;
  id:    string | null;
  retry: number | null;
}

/** Options for the EventSource client connection. */
export interface EventSourceInit {
  headers?: Record<string, string> | Headers;
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
 * from fino:stream or an HTTP response body from fino:http.
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
  #source: AsyncIterable<Uint8Array | ArrayBuffer>;
  #lastEventId: string;

  /** @param {AsyncIterable<Uint8Array|ArrayBuffer>} source — byte stream */
  constructor(source: AsyncIterable<Uint8Array | ArrayBuffer>) {
    this.#source      = source;
    this.#lastEventId = '';
  }

  /**
   * The last event ID seen in the stream. Updated as events are yielded,
   * so it reflects the ID of the most recently yielded event that had an
   * `id:` field. Persists across all events in the stream.
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
   * @yields {{ type: string, data: string, id: string|null, retry: number|null }}
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
  #writer: WriterLike;

  /**
   * @param {{ write(Uint8Array): Promise<number> }} writer
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
   * @param {{ data: string, event?: string, id?: string, retry?: number }} opts
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
   * @param {string} [text='']
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
   * @param {number} ms — reconnection interval in milliseconds
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
  static CONNECTING = CONNECTING;
  static OPEN       = OPEN;
  static CLOSED     = CLOSED;

  #url: string;
  #readyState: number;
  // null = no id: field ever received; '' = empty id: field received.
  // The distinction matters for Last-Event-ID: an empty id should still be
  // sent on reconnect (with an empty value) per the WHATWG EventSource spec.
  #lastEventId: string | null;
  #retryInterval: number;
  #extraHeaders: Headers;
  #currentReader: { close(): void } | null;   // FdReader — set during an active connection; used to abort reads on close()
  #onopen: ((e: Event) => void) | null;
  #onmessage: ((e: MessageEvent) => void) | null;
  #onerror: ((e: Event) => void) | null;

  /**
   * @param {string} url — the SSE endpoint URL (http:// or https://)
   * @param {{ headers?: Record<string,string>|Headers }} [init]
   */
  constructor(url: string, init?: EventSourceInit) {
    super();
    this.#url           = String(url);
    this.#readyState    = CONNECTING;
    this.#lastEventId   = null;
    this.#retryInterval = DEFAULT_RETRY_MS;
    this.#extraHeaders  = init?.headers ? new Headers(init.headers) : new Headers();
    this.#currentReader = null;
    this.#onopen        = null;
    this.#onmessage     = null;
    this.#onerror       = null;

    // Kick off the connection loop. Errors are handled internally.
    this.#run().catch(function swallowEvtSrcErr() {});
  }

  /** Current ready state: CONNECTING (0), OPEN (1), or CLOSED (2). */
  get readyState() { return this.#readyState; }

  /** The URL passed to the constructor. */
  get url() { return this.#url; }

  /** The last event ID received from the server. Sent as Last-Event-ID on reconnect. Empty string before any id: field is received. */
  get lastEventId() { return this.#lastEventId ?? ''; }

  /** Callback for `open` events (connection established). */
  get onopen()    { return this.#onopen; }
  set onopen(fn: ((e: Event) => void) | null)  { this.#onopen = typeof fn === 'function' ? fn : null; }

  /** Callback for `message` events (default-type SSE events). */
  get onmessage()   { return this.#onmessage; }
  set onmessage(fn: ((e: MessageEvent) => void) | null) { this.#onmessage = typeof fn === 'function' ? fn : null; }

  /** Callback for `error` events (connection errors and fatal failures). */
  get onerror()   { return this.#onerror; }
  set onerror(fn: ((e: Event) => void) | null) { this.#onerror = typeof fn === 'function' ? fn : null; }

  /**
   * Close the connection and prevent any further reconnection.
   * Idempotent — safe to call multiple times.
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

  // ---------------------------------------------------------------------------
  // Internal: connection and reconnection loop
  // ---------------------------------------------------------------------------

  async #run() {
    while (this.#readyState !== CLOSED) {
      this.#readyState = CONNECTING;
      let sock: Socket | TlsSocket | null = null;
      let reader: ClosableAsyncByteReader | null = null;

      try {
        // ---- Parse URL --------------------------------------------------------
        const parsed  = new URL(this.#url);
        const isHttps = parsed.protocol === 'https:';
        const hostname = parsed.hostname;
        const port = parsed.port
          ? parseInt(parsed.port, 10)
          : (isHttps ? 443 : 80);
        const path = (parsed.pathname + parsed.search) || '/';
        const origin = parsed.origin;

        // ---- DNS lookup -------------------------------------------------------
        const { address, family } = await lookup(hostname);
        if (this.#readyState === CLOSED) return;

        const addr: IPv4Address | IPv6Address = family === 6
          ? { family: 'ipv6', ip: address, port }
          : { family: 'ipv4', ip: address, port };

        // ---- TCP / TLS connect ------------------------------------------------
        if (isHttps) {
          sock = await TlsSocket.connect(addr, { hostname });
        } else {
          sock = await Socket.connect(addr);
        }
        if (this.#readyState === CLOSED) { _closeSocket(sock); return; }

        // ---- Split and register reader for close() cancellation ---------------
        const [r, writer] = sock.split();
        reader = r;
        this.#currentReader = reader;

        // ---- Build and send HTTP request --------------------------------------
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

        // ---- Parse HTTP response headers -------------------------------------
        const response = await parseResponse(reader);
        if (this.#readyState === CLOSED) return;

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

  #fireOpen(origin: string) {
    const e = new Event('open');
    this.dispatchEvent(e);
    if (this.#onopen) this.#onopen.call(this, e);
  }

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
