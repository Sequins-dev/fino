/**
 * internal:net/http/stream - shared HTTP stream primitives.
 *
 * This module defines the protocol-neutral pieces used by HTTP/2 and HTTP/3
 * drivers before they are adapted to public `Request` and `Response` objects.
 * It keeps stream identifiers, header/trailer lists, lifecycle events, body
 * queues, and transport error categories in one place so HPACK/nghttp2 and
 * QPACK/nghttp3 code can differ without inventing incompatible application
 * semantics.
 *
 * Drivers should dispatch after initial headers are complete and pass an
 * `HttpBodyQueue` as the live request or response body. The queue is bounded:
 * if application code stops consuming, `push()` reports backpressure failure
 * and the protocol driver can reset or close the stream according to its own
 * rules. Consumers use normal async iteration.
 *
 * The types here intentionally do not describe HPACK, QPACK, stream-window
 * frames, QUIC stream binding, or TLS/ALPN. Those remain protocol-specific.
 *
 * A typical driver-to-application handoff looks like this: the driver builds a
 * `HttpBodyQueue`, hands it to the request handler as the live body, and feeds
 * DATA callbacks straight into `push()`. When the peer finishes the stream the
 * driver calls `close()`; on a reset or protocol violation it calls `error()`
 * with an `HttpStreamError` so the awaiting consumer sees a rejection rather
 * than a silent truncation.
 *
 * ```ts no_run
 * import { HttpBodyQueue, HttpStreamError } from 'internal:net/http/stream';
 *
 * const body = new HttpBodyQueue({ maxBufferedBytes: 4 * 1024 * 1024 });
 *
 * // Driver side: native DATA/END callbacks drive the queue synchronously.
 * body.push(new Uint8Array([0x68, 0x69])); // "hi"
 * body.close();
 *
 * // Application side: read the body with ordinary async iteration.
 * let total = 0;
 * for await (const chunk of body) total += chunk.byteLength;
 * console.log('received', total, 'bytes');
 * ```
 *
 * Learn more:
 * - Fetch body streams: https://fetch.spec.whatwg.org/#concept-body
 * - HTTP/2 flow control and stream errors: https://www.rfc-editor.org/rfc/rfc9113
 * - HTTP/3 request cancellation: https://www.rfc-editor.org/rfc/rfc9114
 *
 * @internal
 */
/**
 * Protocol-neutral HTTP stream identifier.
 *
 * A `bigint` is used so that both HTTP/2 stream IDs (31-bit integers) and
 * HTTP/3 stream IDs (62-bit QUIC varints) fit the same type without precision
 * loss. Drivers translate their native numeric IDs into this form on the way
 * in — see `httpStreamIdFromH2` for the HTTP/2 conversion.
 */
export type HttpStreamId = bigint;
/**
 * Ordered HTTP header fields as `[name, value]` pairs, without pseudo-header
 * interpretation.
 *
 * Order is preserved exactly as received or emitted, and pseudo-headers such
 * as `:method` or `:status` appear inline as ordinary entries — this list
 * carries the wire ordering, not an interpreted request or response. Names are
 * lowercase per HTTP/2 and HTTP/3 conventions.
 */
export type HttpStreamHeaders = Array<[string, string]>;
/**
 * Ordered HTTP trailer fields as `[name, value]` pairs.
 *
 * Trailers arrive after the body has been fully streamed and follow the same
 * shape as `HttpStreamHeaders`.
 */
export type HttpStreamTrailers = Array<[string, string]>;
/**
 * Async byte body used for request and response streaming.
 *
 * This is the read-only view a consumer sees; `HttpBodyQueue` is the concrete
 * implementation drivers construct and feed. Iterate it with `for await` to
 * pull body chunks until EOF.
 */
export type HttpStreamBody = AsyncIterable<Uint8Array>;
/**
 * HTTP stream lifecycle events shared by the HTTP/2 and HTTP/3 drivers.
 *
 * Each variant is discriminated by its `kind` field, letting driver-agnostic
 * code react to header arrival, body data, trailers, resets, per-stream close,
 * connection shutdown (GOAWAY), and cancellation with a single switch. The
 * `headers` and `data` variants carry a `fin` / payload respectively; the
 * terminal variants (`reset`, `close`, `cancel`, `shutdown`) optionally carry
 * the `HttpStreamError` that explains why the stream or connection ended.
 *
 * ```ts no_run
 * import type { HttpStreamEvent } from 'internal:net/http/stream';
 *
 * function dispatch(event: HttpStreamEvent): void {
 *   switch (event.kind) {
 *     case 'headers':
 *       console.log('stream', event.streamId, 'headers, fin =', event.fin);
 *       break;
 *     case 'data':
 *       console.log('stream', event.streamId, event.bytes.byteLength, 'bytes');
 *       break;
 *     case 'reset':
 *       console.warn('stream', event.streamId, 'reset:', event.error.code);
 *       break;
 *     case 'shutdown':
 *       console.warn('connection shutdown, last =', event.lastStreamId);
 *       break;
 *   }
 * }
 * ```
 */
export type HttpStreamEvent =
  | {
      kind: 'headers';
      streamId: HttpStreamId;
      headers: HttpStreamHeaders;
      fin: boolean;
    }
  | {
      kind: 'data';
      streamId: HttpStreamId;
      bytes: Uint8Array;
    }
  | {
      kind: 'trailers';
      streamId: HttpStreamId;
      trailers: HttpStreamTrailers;
    }
  | {
      kind: 'reset';
      streamId: HttpStreamId;
      error: HttpStreamError;
    }
  | {
      kind: 'close';
      streamId: HttpStreamId;
      error?: HttpStreamError;
    }
  | {
      kind: 'shutdown';
      lastStreamId?: HttpStreamId;
      error?: HttpStreamError;
    }
  | {
      kind: 'cancel';
      streamId: HttpStreamId;
      error?: HttpStreamError;
    };
/**
 * Transport-level stream error category, normalized across HTTP/2 and HTTP/3.
 *
 * The category abstracts protocol-specific numeric codes (RST_STREAM error
 * codes, QUIC application error codes) into a small vocabulary consumers can
 * branch on: `cancelled` and `refused` for peer-initiated aborts, `closed` for
 * a stream that ended in error state, `flow-control` when a local buffer bound
 * is exceeded, `goaway`/`shutdown` for connection-wide teardown, `protocol`
 * for a framing or header violation, and `transport` for lower-level failures.
 * The original numeric code, when known, is preserved on
 * `HttpStreamError.protocolCode`.
 */
export type HttpStreamErrorCode =
  | 'cancelled'
  | 'closed'
  | 'flow-control'
  | 'goaway'
  | 'protocol'
  | 'refused'
  | 'shutdown'
  | 'transport';
/**
 * Error raised by shared HTTP stream state and surfaced through driver adapters.
 *
 * Carries a normalized `code` category, the `streamId` it applies to (or
 * `null` for connection-scoped failures), and the raw `protocolCode` from the
 * wire when available. A `HttpBodyQueue` fed one of these via `error()` rejects
 * both `closed` and any in-flight or subsequent read, so an awaiting consumer
 * sees the failure instead of a silently truncated body.
 *
 * ```ts no_run
 * import { HttpBodyQueue, HttpStreamError } from 'internal:net/http/stream';
 *
 * const body = new HttpBodyQueue();
 * body.error(new HttpStreamError('cancelled', 'peer reset stream 5', {
 *   streamId: 5,
 *   protocolCode: 0x8, // HTTP/2 CANCEL
 * }));
 *
 * try {
 *   for await (const chunk of body) console.log(chunk); // never runs
 * } catch (err) {
 *   if (err instanceof HttpStreamError && err.code === 'cancelled') {
 *     console.warn('body aborted on stream', err.streamId);
 *   }
 * }
 * ```
 */
export class HttpStreamError extends Error {
  /** Normalized transport-level category for this failure. */
  readonly code: HttpStreamErrorCode;
  /** Stream the error applies to, or `null` for connection-scoped failures. */
  readonly streamId: HttpStreamId | null;
  /** Raw protocol error code from the wire, or `null` when not supplied. */
  readonly protocolCode: number | bigint | null;
  /**
   * Construct a stream error from a normalized category and message.
   *
   * A numeric `streamId` is accepted for convenience and coerced to the shared
   * `bigint` form; omit it for connection-scoped errors so `streamId` reads as
   * `null`.
   */
  constructor(
    code: HttpStreamErrorCode,
    message: string,
    options: {
      streamId?: HttpStreamId | number;
      protocolCode?: number | bigint;
    } = {},
  ) {
    super(message);
    this.name = 'HttpStreamError';
    this.code = code;
    this.streamId = options.streamId === undefined ? null : BigInt(options.streamId);
    this.protocolCode = options.protocolCode ?? null;
  }
}
interface QueueWaiter {
  resolve(value: IteratorResult<Uint8Array>): void;
  reject(reason: unknown): void;
}
/**
 * Construction options for `HttpBodyQueue`.
 *
 * `maxBufferedBytes` bounds how many unread bytes may accumulate before the
 * producer is told to stop. Drivers can also install `onCancel` to translate
 * early consumer exit into a protocol-level stream reset.
 *
 * ```ts no_run
 * import { HttpBodyQueue } from 'internal:net/http/stream';
 *
 * // Cap this stream's unread buffer at 1 MiB.
 * const body = new HttpBodyQueue({ maxBufferedBytes: 1024 * 1024 });
 * ```
 */
export interface HttpBodyQueueOptions {
  /** Maximum queued, unread bytes before `push()` fails. Defaults to 16 MiB. */
  maxBufferedBytes?: number;
  /**
   * Optional hook invoked when the consumer stops before EOF.
   *
   * Protocol drivers use this to translate async-iterator or `ReadableStream`
   * cancellation into a stream reset without closing unrelated multiplexed
   * streams. The returned promise, when any, is awaited by iterator `return()`.
   */
  onCancel?: (reason: unknown) => void | Promise<void>;
}
const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
/**
 * Bounded async byte queue shared by HTTP/2 and HTTP/3 streams.
 *
 * This is the concrete backing for `HttpStreamBody`. The producer side
 * (`push`, `close`, `error`) is synchronous so native protocol callbacks can
 * decide immediately whether a stream exceeded local buffering limits and reset
 * accordingly. The consumer side is a normal async iterator, so request and
 * response bodies read with an ordinary `for await` loop.
 *
 * Backpressure is enforced by a byte bound rather than a signal: when unread
 * chunks would push `queuedBytes` past `maxBufferedBytes` and no consumer is
 * currently waiting, `push()` errors the queue with a `flow-control`
 * `HttpStreamError` and returns `false`, letting the driver reset the stream.
 * If a consumer is already parked waiting on a chunk, the chunk is handed off
 * directly and the bound is not consulted. Empty chunks are accepted and
 * ignored.
 *
 * `closed` resolves when EOF is observed via `close()` and rejects when the
 * stream errors or is cancelled via `error()`. Once closed or errored the queue
 * is terminal: further `push`/`close`/`error` calls are no-ops.
 *
 * ```ts no_run
 * import { HttpBodyQueue } from 'internal:net/http/stream';
 *
 * const body = new HttpBodyQueue();
 *
 * // Consumer: track EOF without iterating.
 * body.closed.then(() => console.log('body complete'));
 *
 * // Producer: driver callbacks feed frames in, then signal EOF.
 * body.push(new Uint8Array([1, 2, 3]));
 * body.push(new Uint8Array([4, 5]));
 * body.close();
 *
 * for await (const chunk of body) console.log('chunk', chunk.byteLength);
 * console.log('total received', body.receivedBytes);
 * ```
 *
 * @internal
 */
export class HttpBodyQueue implements AsyncIterable<Uint8Array> {
  #chunks: Uint8Array[] = [];
  #waiters: QueueWaiter[] = [];
  #closed = false;
  #error: unknown = null;
  #queuedBytes = 0;
  #receivedBytes = 0;
  readonly #maxBufferedBytes: number;
  readonly #onCancel: ((reason: unknown) => void | Promise<void>) | null;
  readonly #closedPromise: Promise<void>;
  #resolveClosed!: () => void;
  #rejectClosed!: (reason: unknown) => void;
  /**
   * Create an empty queue, optionally overriding the buffered-byte bound and
   * installing a consumer-cancellation hook for the protocol driver.
   *
   * With no options the bound defaults to 16 MiB.
   */
  constructor(options: HttpBodyQueueOptions = {}) {
    this.#maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.#onCancel = options.onCancel ?? null;
    this.#closedPromise = new Promise<void>((resolve, reject) => {
      this.#resolveClosed = resolve;
      this.#rejectClosed = reject;
    });
    void this.#closedPromise.catch(() => {});
  }
  /** Total non-empty bytes accepted by `push()` since construction. */
  get receivedBytes(): number {
    return this.#receivedBytes;
  }
  /** Bytes currently buffered and awaiting consumer reads. */
  get queuedBytes(): number {
    return this.#queuedBytes;
  }
  /**
   * Promise that resolves once EOF is reached and rejects if the stream errors.
   *
   * Useful for observing completion without iterating the body — for example to
   * detect a truncated upload. Its rejection is pre-caught internally, so it is
   * safe to read `closed` lazily without triggering an unhandled rejection.
   */
  get closed(): Promise<void> {
    return this.#closedPromise;
  }
  /**
   * Offer one body chunk to the queue.
   *
   * If a consumer is already awaiting, the chunk is delivered to it directly;
   * otherwise it is buffered until the next read. Empty chunks are accepted and
   * ignored (returning `true` without changing `receivedBytes`).
   *
   * Returns `false` when the chunk was not accepted: either the stream is
   * already closed or errored, or buffering it would exceed `maxBufferedBytes`
   * while no consumer is waiting. In the overflow case the queue is additionally
   * transitioned to errored state with a `flow-control` `HttpStreamError`, so
   * the driver can treat a `false` return as a signal to reset the stream.
   */
  push(chunk: Uint8Array): boolean {
    if (this.#closed || this.#error !== null) return false;
    if (chunk.byteLength === 0) return true;
    if (
      this.#queuedBytes + chunk.byteLength > this.#maxBufferedBytes &&
      this.#waiters.length === 0
    ) {
      this.error(
        new HttpStreamError('flow-control', 'HTTP body queue exceeded buffered byte limit'),
      );
      return false;
    }
    this.#receivedBytes += chunk.byteLength;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({
        done: false,
        value: chunk,
      });
    } else {
      this.#chunks.push(chunk);
      this.#queuedBytes += chunk.byteLength;
    }
    return true;
  }
  /**
   * Signal end-of-body.
   *
   * Resolves `closed`, delivers a `done` result to every waiting consumer, and
   * makes future reads return `done` once the buffered chunks drain. A no-op if
   * the queue is already closed or errored.
   */
  close(): void {
    if (this.#closed || this.#error !== null) return;
    this.#closed = true;
    this.#resolveClosed();
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters)
      waiter.resolve({
        done: true,
        value: undefined as any,
      });
  }
  /**
   * Fault the stream, rejecting `closed` and all pending or future reads.
   *
   * Pass an `HttpStreamError` describing the transport failure so consumers can
   * branch on its `code`. A no-op if the queue is already closed or errored, so
   * the first terminal signal wins.
   */
  error(reason: unknown): void {
    if (this.#closed || this.#error !== null) return;
    this.#error = reason;
    this.#rejectClosed(reason);
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter.reject(reason);
  }
  async #cancel(reason: unknown): Promise<void> {
    if (this.#error !== null) return;
    this.#chunks.length = 0;
    this.#queuedBytes = 0;
    if (this.#closed) return;
    const error =
      reason instanceof HttpStreamError
        ? reason
        : new HttpStreamError('cancelled', 'HTTP body consumption was cancelled');
    this.error(error);
    if (this.#onCancel !== null) await this.#onCancel(reason);
  }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        if (this.#chunks.length > 0) {
          const value = this.#chunks.shift()!;
          this.#queuedBytes -= value.byteLength;
          return Promise.resolve({
            done: false,
            value,
          });
        }
        if (this.#error !== null) return Promise.reject(this.#error);
        if (this.#closed)
          return Promise.resolve({
            done: true,
            value: undefined as any,
          });
        return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
          this.#waiters.push({
            resolve,
            reject,
          });
        });
      },
      return: async (reason?: unknown) => {
        await this.#cancel(reason);
        return {
          done: true,
          value: undefined as any,
        };
      },
    };
  }
}
/**
 * Convert a numeric HTTP/2 stream ID to the shared `HttpStreamId` bigint form.
 *
 * HTTP/2 stream IDs are 31-bit integers that fit a JS number exactly, but the
 * protocol-neutral layer works in `bigint` so HTTP/2 and HTTP/3 IDs share one
 * type. Use this at the boundary where nghttp2 callbacks hand you a numeric ID.
 *
 * ```ts no_run
 * import { httpStreamIdFromH2 } from 'internal:net/http/stream';
 *
 * // nghttp2 reports stream IDs as plain numbers.
 * const id = httpStreamIdFromH2(5);
 * console.log(id); // 5n
 * ```
 */
export function httpStreamIdFromH2(streamId: number): HttpStreamId {
  return BigInt(streamId);
}
