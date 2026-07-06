/**
* fino:net/http/eventstream — transport-agnostic SSE parser and formatter.
*
* Provides the wire-level primitives for Server-Sent Events independently of
* any specific HTTP transport. `EventSource` layers its GET-only reconnecting
* client on top; AI model providers use `parseEventStream` directly for
* POST-body SSE streams.
*
* ```ts no_run
* import { parseEventStream } from 'fino:net/http/eventstream';
* import { HttpClient } from 'fino:net/http/client';
*
* const client = new HttpClient();
* const res = await client.request(url, {
*   method: 'POST',
*   body: JSON.stringify({ stream: true }),
*   headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
* });
* for await (const event of parseEventStream(res.body)) {
*   console.log(event.type, event.data);
* }
* ```
*/
import { Reader, Writer } from '../../internal/stream.ts';
import type { BytesWriter } from '../../internal/stream.ts';
import { decodeUtf8, encodeUtf8 } from 'internal:encoding';
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
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
  /** Event type; defaults to `"message"` when the stream omits `event:`. */
  type: string;
  /** Event payload with multiple `data:` lines joined by newline. */
  data: string;
  /** Event ID from `id:`, or `null` when absent. */
  id: string | null;
  /** Retry interval from `retry:`, or `null` when absent or invalid. */
  retry: number | null;
}
/**
* Options accepted by `EventSourceWriter.write()` / `.event()`.
*
* Only `data` is required; all other fields are optional.
*
* ```ts no_run
* await writer.write({ event: 'update', data: 'payload', id: '1' });
* ```
*/
export interface SseEventOptions {
  /** Event payload. Multi-line strings are split into one `data:` line each. */
  data: string;
  /** Event type written as an `event:` field; the client's `message` handler fires when omitted. */
  event?: string;
  /** Event ID written as an `id:` field; the client echoes it back as `Last-Event-ID` on reconnect. */
  id?: string;
  /** Reconnection interval in milliseconds, floored to an integer and written as a `retry:` field. */
  retry?: number;
}
// ---------------------------------------------------------------------------
// Internal: line splitter
// ---------------------------------------------------------------------------
/**
* Split an async byte stream into text lines.
*
* Recognizes LF, CRLF, and bare CR as terminators per the W3C SSE spec.
* Terminators are stripped; handles terminators split across chunk boundaries.
*/
async function* _lines(source: AsyncIterable<Uint8Array | ArrayBuffer>): AsyncGenerator<string> {
  let buf = '';
  for await (const chunk of source) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    buf += decodeUtf8(bytes);
    let start = 0;
    let i = 0;
    while (i < buf.length) {
      const ch = buf.charCodeAt(i);
      if (ch === 10) {
        yield buf.substring(start, i);
        i++;
        start = i;
      } else if (ch === 13) {
        yield buf.substring(start, i);
        i++;
        if (i < buf.length && buf.charCodeAt(i) === 10) i++;
        start = i;
      } else {
        i++;
      }
    }
    buf = start < buf.length ? buf.substring(start) : '';
  }
  if (buf.length > 0) yield buf;
}
// ---------------------------------------------------------------------------
// EventSourceReader — SSE parser
// ---------------------------------------------------------------------------
/**
* Parses an SSE byte stream into discrete `SseEvent` objects.
*
* Extends `Reader<SseEvent>` so it inherits `for await`, `close()`, `closed`,
* and `[Symbol.asyncDispose]()`. Accepts any async iterable of byte chunks.
*
* ```ts no_run
* const reader = new EventSourceReader(response.body);
* for await (const event of reader) {
*   console.log(event.type, event.data);
* }
* console.log(reader.lastEventId);
* ```
*/
export class EventSourceReader extends Reader<SseEvent> {
  #source: AsyncIterable<Uint8Array | ArrayBuffer>;
  #lastEventId: string;
  #gen: AsyncGenerator<SseEvent> | null = null;
  /**
  * Create an SSE parser over a byte stream.
  *
  * The parser is single-use; it consumes the source iterator as it yields events.
  *
  * ```ts no_run
  * const reader = new EventSourceReader(response.body);
  * ```
  */
  constructor(source: AsyncIterable<Uint8Array | ArrayBuffer>) {
    super();
    this.#source = source;
    this.#lastEventId = '';
  }
  /**
  * The last event ID seen in the stream. Reflects the `id:` field of the
  * most recently yielded event. Persists across all events in the stream.
  *
  * ```ts no_run
  * console.log(reader.lastEventId);
  * ```
  */
  get lastEventId(): string {
    return this.#lastEventId;
  }
  /**
  * Pull the next parsed event from the stream, or `null` once the source is
  * exhausted.
  *
  * This is the pull-based counterpart to `for await`; the inherited async
  * iterator calls it under the hood. Events with no `data:` field are skipped
  * rather than yielded, so each resolved value always carries a payload. The
  * parser reads and buffers as many source chunks as needed to complete one
  * event before resolving.
  *
  * ```ts no_run
  * const reader = new EventSourceReader(response.body);
  * let event;
  * while ((event = await reader.read()) !== null) {
  *   console.log(event.type, event.data);
  * }
  * ```
  */
  async read(): Promise<SseEvent | null> {
    if (this.#gen === null) this.#gen = this.#parse();
    const result = await this.#gen.next();
    return result.done ? null : result.value;
  }
  async *#parse(): AsyncGenerator<SseEvent> {
    let eventType = '';
    let data: string[] = [];
    let eventId: string | null = null;
    let hasData = false;
    let retry: number | null = null;
    for await (const line of _lines(this.#source)) {
      if (line === '') {
        if (hasData) {
          if (eventId !== null) this.#lastEventId = eventId;
          yield {
            type: eventType || 'message',
            data: data.join('\n'),
            id: eventId,
            retry
          };
        }
        eventType = '';
        data = [];
        eventId = null;
        hasData = false;
        retry = null;
        continue;
      }
      if (line.charCodeAt(0) === 58) continue;
      const colonIdx = line.indexOf(':');
      let field: string;
      let value: string;
      if (colonIdx === -1) {
        field = line;
        value = '';
      } else {
        field = line.substring(0, colonIdx);
        const vStart = colonIdx + 1;
        value = vStart < line.length && line.charCodeAt(vStart) === 32 ? line.substring(vStart + 1) : line.substring(vStart);
      }
      if (field === 'data') {
        data.push(value);
        hasData = true;
      } else if (field === 'event') {
        eventType = value;
      } else if (field === 'id') {
        if (!value.includes('\0')) eventId = value;
      } else if (field === 'retry') {
        if (/^\d+$/.test(value)) retry = parseInt(value, 10);
      }
    }
    if (hasData) {
      if (eventId !== null) this.#lastEventId = eventId;
      yield {
        type: eventType || 'message',
        data: data.join('\n'),
        id: eventId,
        retry
      };
    }
  }
}
// ---------------------------------------------------------------------------
// EventSourceWriter — SSE formatter
// ---------------------------------------------------------------------------
/**
* Formats and writes SSE events to a `BytesWriter`.
*
* Extends `Writer<SseEventOptions>` so it inherits `pipe()`, `close()`,
* `closed`, and `[Symbol.asyncDispose]()`.
*
* The underlying `BytesWriter` is not closed when this writer is closed.
* Callers are responsible for flushing and closing the byte sink.
*
* ```ts no_run
* const esw = new EventSourceWriter(writer);
* await esw.write({ data: 'hello' });
* await esw.write({ event: 'update', data: 'line1\nline2', id: '42' });
* await esw.comment('keep-alive');
* await esw.retry(5000);
* ```
*/
export class EventSourceWriter extends Writer<SseEventOptions> {
  #writer: Writer<Uint8Array>;
  /**
  * Create an SSE writer around any byte-accepting writer, such as a
  * `BytesWriter` or the writer end of a `Channel<Uint8Array>`.
  *
  * ```ts no_run
  * const events = new EventSourceWriter(writer);
  * ```
  */
  constructor(writer: Writer<Uint8Array> | BytesWriter) {
    super();
    this.#writer = writer;
  }
  /**
  * Write an SSE event.
  *
  * Multi-line `data` strings are split into separate `data:` lines.
  * `retry` is floored to an integer. Field values are not escaped.
  *
  * ```ts no_run
  * await events.write({ event: 'update', data: 'line 1\nline 2', id: '42' });
  * ```
  */
  async write(opts: SseEventOptions): Promise<void> {
    let frame = '';
    if (opts.event !== undefined && opts.event !== null) {
      frame += 'event: ' + String(opts.event) + '\n';
    }
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
    frame += '\n';
    await this.#writer.write(encodeUtf8(frame));
  }
  /**
  * Alias for `write()`. Provided for compatibility and readability in
  * server-side SSE handlers.
  *
  * ```ts no_run
  * await events.event({ event: 'update', data: 'payload' });
  * ```
  */
  event(opts: SseEventOptions): Promise<void> {
    return this.write(opts);
  }
  /**
  * Write a comment line. Useful for keep-alive heartbeats.
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
  * ```ts no_run
  * await events.retry(5000);
  * ```
  */
  async retry(ms: number): Promise<void> {
    await this.#writer.write(encodeUtf8('retry: ' + Math.floor(Number(ms)) + '\n\n'));
  }
}
// ---------------------------------------------------------------------------
// parseEventStream — convenience factory
// ---------------------------------------------------------------------------
/**
* Parse an async byte stream as SSE events.
*
* Returns an `EventSourceReader` which is both `AsyncIterable<SseEvent>` and
* a `Reader<SseEvent>` with `close()`, `closed`, `lastEventId`, and
* `[Symbol.asyncDispose]()`.
*
* ```ts no_run
* import { parseEventStream } from 'fino:net/http/eventstream';
*
* for await (const event of parseEventStream(res.body)) {
*   console.log(event.type, event.data);
* }
* ```
*/
export function parseEventStream(source: AsyncIterable<Uint8Array | ArrayBuffer>): EventSourceReader {
  return new EventSourceReader(source);
}
