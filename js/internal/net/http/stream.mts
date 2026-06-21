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
 * @example
 * ```ts no_run
 * import { HttpBodyQueue } from 'internal:net/http/stream';
 *
 * const body = new HttpBodyQueue();
 * body.push(new Uint8Array([65]));
 * body.close();
 * for await (const chunk of body) console.log(chunk.byteLength);
 * ```
 *
 * @internal
 */

/** Protocol-neutral HTTP stream identifier. */
export type HttpStreamId = bigint;

/** Ordered HTTP header fields without pseudo-header interpretation. */
export type HttpStreamHeaders = Array<[string, string]>;

/** Ordered HTTP trailer fields. */
export type HttpStreamTrailers = Array<[string, string]>;

/** Async byte body used for request and response streaming. */
export type HttpStreamBody = AsyncIterable<Uint8Array>;

/** HTTP stream lifecycle events shared by H2 and H3 drivers. */
export type HttpStreamEvent =
  | { kind: 'headers'; streamId: HttpStreamId; headers: HttpStreamHeaders; fin: boolean }
  | { kind: 'data'; streamId: HttpStreamId; bytes: Uint8Array }
  | { kind: 'trailers'; streamId: HttpStreamId; trailers: HttpStreamTrailers }
  | { kind: 'reset'; streamId: HttpStreamId; error: HttpStreamError }
  | { kind: 'close'; streamId: HttpStreamId; error?: HttpStreamError }
  | { kind: 'shutdown'; lastStreamId?: HttpStreamId; error?: HttpStreamError }
  | { kind: 'cancel'; streamId: HttpStreamId; error?: HttpStreamError };

/** Transport-level stream error category. */
export type HttpStreamErrorCode =
  | 'cancelled'
  | 'closed'
  | 'flow-control'
  | 'goaway'
  | 'protocol'
  | 'refused'
  | 'shutdown'
  | 'transport';

/** Error class used by shared HTTP stream state and driver adapters. */
export class HttpStreamError extends Error {
  readonly code: HttpStreamErrorCode;
  readonly streamId: HttpStreamId | null;
  readonly protocolCode: number | bigint | null;

  constructor(
    code: HttpStreamErrorCode,
    message: string,
    options: { streamId?: HttpStreamId | number; protocolCode?: number | bigint } = {},
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

/** Options for `HttpBodyQueue`. */
export interface HttpBodyQueueOptions {
  /** Maximum queued, unread bytes before `push()` fails. Defaults to 16 MiB. */
  maxBufferedBytes?: number;
}

const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

/**
 * Bounded async byte queue shared by HTTP/2 and HTTP/3 streams.
 *
 * The producer side is synchronous so native protocol callbacks can decide
 * immediately whether a stream exceeded local buffering limits. The consumer
 * side is a normal async iterator. `closed` resolves when EOF is observed and
 * rejects when the stream errors or is cancelled.
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
  readonly #closedPromise: Promise<void>;
  #resolveClosed!: () => void;
  #rejectClosed!: (reason: unknown) => void;

  constructor(options: HttpBodyQueueOptions = {}) {
    this.#maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.#closedPromise = new Promise<void>((resolve, reject) => {
      this.#resolveClosed = resolve;
      this.#rejectClosed = reject;
    });
    void this.#closedPromise.catch(() => {});
  }

  /** Total bytes accepted since construction. */
  get receivedBytes(): number { return this.#receivedBytes; }

  /** Currently buffered bytes waiting for consumer reads. */
  get queuedBytes(): number { return this.#queuedBytes; }

  /** Promise that resolves at EOF and rejects on stream error. */
  get closed(): Promise<void> { return this.#closedPromise; }

  /**
   * Push one body chunk.
   *
   * Returns `false` if the stream is already closed/errored or if accepting the
   * chunk would exceed the configured buffer bound.
   */
  push(chunk: Uint8Array): boolean {
    if (this.#closed || this.#error !== null) return false;
    if (chunk.byteLength === 0) return true;
    if (this.#queuedBytes + chunk.byteLength > this.#maxBufferedBytes && this.#waiters.length === 0) {
      this.error(new HttpStreamError('flow-control', 'HTTP body queue exceeded buffered byte limit'));
      return false;
    }
    this.#receivedBytes += chunk.byteLength;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: chunk });
    } else {
      this.#chunks.push(chunk);
      this.#queuedBytes += chunk.byteLength;
    }
    return true;
  }

  /** Close the stream at EOF. */
  close(): void {
    if (this.#closed || this.#error !== null) return;
    this.#closed = true;
    this.#resolveClosed();
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter.resolve({ done: true, value: undefined as any });
  }

  /** Error the stream and reject pending or future reads. */
  error(reason: unknown): void {
    if (this.#closed || this.#error !== null) return;
    this.#error = reason;
    this.#rejectClosed(reason);
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter.reject(reason);
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        if (this.#chunks.length > 0) {
          const value = this.#chunks.shift()!;
          this.#queuedBytes -= value.byteLength;
          return Promise.resolve({ done: false, value });
        }
        if (this.#error !== null) return Promise.reject(this.#error);
        if (this.#closed) return Promise.resolve({ done: true, value: undefined as any });
        return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
    };
  }
}

/** Convert a numeric H2 stream ID to the shared bigint form. */
export function httpStreamIdFromH2(streamId: number): HttpStreamId {
  return BigInt(streamId);
}
