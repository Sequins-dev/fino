/**
 * internal:async-channel — bounded, Realm-local asynchronous value delivery.
 *
 * `AsyncChannel<T>` is the common lifecycle mechanism for producers and
 * consumers that exchange values within one Realm. It combines FIFO delivery,
 * optional weighted buffering, producer backpressure, abortable sends and
 * receives, graceful close, immediate failure, and async-iterator cleanup.
 * Values are retained by reference; the channel does not clone values or make
 * them transferable across Realms.
 *
 * A graceful `close()` rejects sends that have not yet been admitted, then lets
 * already-buffered values drain before iteration ends. `fail(reason)` discards
 * buffered values and rejects pending and future receives immediately. The
 * first call to `close()`, `fail()`, or iterator `return()` wins; repeating
 * terminal operations is harmless.
 *
 * Capacity is measured only for admitted buffered values. A value delivered
 * directly to a waiting receiver consumes no capacity. The default capacity is
 * `Infinity`; callers that accept untrusted or open-ended input should choose a
 * finite capacity. A capacity of zero creates a rendezvous channel.
 *
 * ```ts no_run
 * import { AsyncChannel } from 'internal:async-channel';
 *
 * const channel = new AsyncChannel<Uint8Array>({
 *   capacity: 64 * 1024,
 *   weight: (chunk) => chunk.byteLength,
 * });
 *
 * const producer = channel.send(new Uint8Array([1, 2, 3]));
 * const first = await channel.receive();
 * await producer;
 * channel.close();
 * ```
 *
 * @internal
 */

/** Options controlling an `AsyncChannel`'s buffered capacity. @internal */
export interface AsyncChannelOptions<T> {
  /**
   * Maximum total weight of admitted values waiting for a receiver.
   *
   * Defaults to `Infinity`. Zero is valid and requires every send to rendezvous
   * with a receiver.
   */
  capacity?: number;
  /**
   * Return the non-negative safe-integer weight of a value.
   *
   * Defaults to one per value. The function runs once for each send attempt,
   * before the value is retained by the channel.
   */
  weight?: (value: T) => number;
}

/** Abort options accepted by blocking channel operations. @internal */
export interface AsyncChannelWaitOptions {
  /** Abort a send or receive that has not settled yet. */
  signal?: AbortSignal | null;
}

/** Error used when channel shutdown prevents a producer from sending. @internal */
export class AsyncChannelClosedError extends Error {
  /** Stable error name for channel shutdown failures. @internal */
  override name = 'AsyncChannelClosedError';

  /** Create a channel-closed error with an optional diagnostic message. @internal */
  constructor(message = 'AsyncChannel is closed') {
    super(message);
  }
}

interface Entry<T> {
  value: T;
  weight: number;
}

interface SendWaiter<T> extends Entry<T> {
  resolve(): void;
  reject(reason: unknown): void;
  cleanup(): void;
}

interface ReceiveWaiter<T> {
  resolve(result: IteratorResult<T>): void;
  reject(reason: unknown): void;
  cleanup(): void;
}

type ChannelState = 'open' | 'closed' | 'failed' | 'cancelled';

/**
 * A FIFO async channel with optional weighted capacity and backpressure.
 *
 * `send()` resolves once its value is delivered directly or admitted to the
 * buffer. `trySend()` performs the same admission check without waiting.
 * `receive()` supports cancellation; `next()` supplies the standard
 * `AsyncIterator` surface. Calling iterator `return()` cancels the whole
 * channel because an `AsyncChannel` represents one consumer lifecycle.
 *
 * @internal
 */
export class AsyncChannel<T> implements AsyncIterableIterator<T> {
  readonly #capacity: number;
  readonly #weight: (value: T) => number;
  readonly #entries: Entry<T>[] = [];
  #entryIndex = 0;
  #bufferedWeight = 0;
  readonly #sendWaiters: SendWaiter<T>[] = [];
  readonly #receiveWaiters: ReceiveWaiter<T>[] = [];
  #state: ChannelState = 'open';
  #failure: unknown;
  readonly #closedError = new AsyncChannelClosedError();

  /** Create a channel with optional item- or caller-defined weighted capacity. */
  constructor(options: AsyncChannelOptions<T> = {}) {
    const capacity = options.capacity ?? Infinity;
    if (capacity !== Infinity && (!Number.isSafeInteger(capacity) || capacity < 0)) {
      throw new RangeError('AsyncChannel capacity must be a non-negative safe integer or Infinity');
    }
    this.#capacity = capacity;
    this.#weight = options.weight ?? (() => 1);
  }

  /** Maximum buffered weight configured for this channel. */
  get capacity(): number {
    return this.#capacity;
  }

  /** Total weight of values currently admitted and awaiting delivery. */
  get bufferedWeight(): number {
    return this.#bufferedWeight;
  }

  /** Number of admitted values currently awaiting delivery. */
  get bufferedItems(): number {
    return this.#entries.length - this.#entryIndex;
  }

  /** Whether a terminal operation has stopped new sends. */
  get closed(): boolean {
    return this.#state !== 'open';
  }

  /**
   * Send a value, waiting until it can be delivered or admitted.
   *
   * Sends are admitted in call order. Aborting a blocked send removes it from
   * that order and rejects with `signal.reason`; an already-admitted send is
   * unaffected by later aborts.
   */
  send(value: T, options: AsyncChannelWaitOptions = {}): Promise<void> {
    if (this.#state !== 'open') return Promise.reject(this.#sendError());
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    const weight = this.#valueWeight(value);
    if (this.#sendWaiters.length === 0 && this.#accept(value, weight)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let cleanup = () => {};
      const waiter: SendWaiter<T> = {
        value,
        weight,
        resolve,
        reject,
        cleanup: () => cleanup(),
      };
      const onAbort = () => {
        const index = this.#sendWaiters.indexOf(waiter);
        if (index < 0) return;
        this.#sendWaiters.splice(index, 1);
        cleanup();
        reject(options.signal!.reason);
        this.#drain();
      };
      if (options.signal !== undefined && options.signal !== null) {
        options.signal.addEventListener('abort', onAbort, { once: true });
        cleanup = () => options.signal!.removeEventListener('abort', onAbort);
      }
      this.#sendWaiters.push(waiter);
      this.#drain();
    });
  }

  /**
   * Attempt to send without waiting.
   *
   * Returns `false` when the channel is terminal, an earlier blocked producer
   * owns admission priority, or the value would exceed available capacity.
   */
  trySend(value: T): boolean {
    if (this.#state !== 'open' || this.#sendWaiters.length > 0) return false;
    const weight = this.#valueWeight(value);
    return this.#accept(value, weight);
  }

  /**
   * Receive the next value, wait for one, or observe terminal state.
   *
   * Graceful close returns `{ done: true }` after buffered values drain;
   * failure rejects with the exact failure reason.
   */
  receive(options: AsyncChannelWaitOptions = {}): Promise<IteratorResult<T>> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    const entry = this.#shiftEntry();
    if (entry !== undefined) {
      this.#drain();
      return Promise.resolve({ done: false, value: entry.value });
    }
    if (this.#state === 'failed') return Promise.reject(this.#failure);
    if (this.#state !== 'open') return Promise.resolve(this.#done());
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      let cleanup = () => {};
      const waiter: ReceiveWaiter<T> = {
        resolve,
        reject,
        cleanup: () => cleanup(),
      };
      const onAbort = () => {
        const index = this.#receiveWaiters.indexOf(waiter);
        if (index < 0) return;
        this.#receiveWaiters.splice(index, 1);
        cleanup();
        reject(options.signal!.reason);
      };
      if (options.signal !== undefined && options.signal !== null) {
        options.signal.addEventListener('abort', onAbort, { once: true });
        cleanup = () => options.signal!.removeEventListener('abort', onAbort);
      }
      this.#receiveWaiters.push(waiter);
      this.#drain();
    });
  }

  /** Stop new sends and finish receivers after admitted values drain. */
  close(): void {
    if (this.#state !== 'open') return;
    this.#state = 'closed';
    this.#rejectSenders(this.#closedError);
    this.#drain();
  }

  /** Discard buffered values and reject receivers with `reason`. */
  fail(reason: unknown): void {
    if (this.#state !== 'open') return;
    this.#state = 'failed';
    this.#failure = reason;
    this.#clearEntries();
    this.#rejectSenders(reason);
    const waiters = this.#receiveWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.cleanup();
      waiter.reject(reason);
    }
  }

  /** Standard async-iterator read, equivalent to `receive()`. */
  next(): Promise<IteratorResult<T>> {
    return this.receive();
  }

  /**
   * Cancel consumption and release all retained values.
   *
   * Pending producers reject with `AsyncChannelClosedError`; pending consumers
   * and later iterator reads finish normally.
   */
  return(): Promise<IteratorResult<T>> {
    if (this.#state === 'open') {
      this.#state = 'cancelled';
      this.#clearEntries();
      this.#rejectSenders(this.#closedError);
      this.#finishReceivers();
    }
    return Promise.resolve(this.#done());
  }

  /** Return this Realm-local channel as its single async iterator. */
  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  #valueWeight(value: T): number {
    const weight = this.#weight(value);
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new RangeError('AsyncChannel value weight must be a non-negative safe integer');
    }
    return weight;
  }

  #accept(value: T, weight: number): boolean {
    const receiver = this.#receiveWaiters.shift();
    if (receiver !== undefined) {
      receiver.cleanup();
      receiver.resolve({ done: false, value });
      return true;
    }
    if (weight > this.#capacity - this.#bufferedWeight) return false;
    this.#entries.push({ value, weight });
    this.#bufferedWeight += weight;
    return true;
  }

  #shiftEntry(): Entry<T> | undefined {
    if (this.#entryIndex >= this.#entries.length) return undefined;
    const entry = this.#entries[this.#entryIndex++]!;
    this.#bufferedWeight -= entry.weight;
    if (this.#entryIndex >= 64 && this.#entryIndex * 2 >= this.#entries.length) {
      this.#entries.splice(0, this.#entryIndex);
      this.#entryIndex = 0;
    }
    return entry;
  }

  #drain(): void {
    while (this.#receiveWaiters.length > 0) {
      const entry = this.#shiftEntry();
      if (entry !== undefined) {
        const receiver = this.#receiveWaiters.shift()!;
        receiver.cleanup();
        receiver.resolve({ done: false, value: entry.value });
        continue;
      }
      if (this.#state !== 'open' || this.#sendWaiters.length === 0) break;
      const sender = this.#sendWaiters.shift()!;
      const receiver = this.#receiveWaiters.shift()!;
      sender.cleanup();
      receiver.cleanup();
      sender.resolve();
      receiver.resolve({ done: false, value: sender.value });
    }
    if (this.#state === 'open' && this.#receiveWaiters.length === 0) {
      while (this.#sendWaiters.length > 0) {
        const sender = this.#sendWaiters[0]!;
        if (sender.weight > this.#capacity - this.#bufferedWeight) break;
        this.#sendWaiters.shift();
        this.#entries.push({ value: sender.value, weight: sender.weight });
        this.#bufferedWeight += sender.weight;
        sender.cleanup();
        sender.resolve();
      }
    }
    if (this.#state === 'closed' && this.bufferedItems === 0) this.#finishReceivers();
  }

  #clearEntries(): void {
    this.#entries.length = 0;
    this.#entryIndex = 0;
    this.#bufferedWeight = 0;
  }

  #rejectSenders(reason: unknown): void {
    const waiters = this.#sendWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.cleanup();
      waiter.reject(reason);
    }
  }

  #finishReceivers(): void {
    const waiters = this.#receiveWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.cleanup();
      waiter.resolve(this.#done());
    }
  }

  #sendError(): unknown {
    return this.#state === 'failed' ? this.#failure : this.#closedError;
  }

  #done(): IteratorResult<T> {
    return { done: true, value: undefined as T };
  }
}
