/**
 * internal:serial-executor — Realm-local FIFO execution gates.
 *
 * Serialize operations that share mutable state without tying ordering to a
 * workflow, database, or transport. Failures belong to each returned promise
 * and do not poison later operations. These gates provide neither durability
 * nor transactions and must not be awaited recursively from their own slot.
 *
 * Queued cancellation removes an operation before it starts. Once started,
 * cancellation is cooperative: the operation owns its signal and retains the
 * slot until it settles. No external work is interrupted automatically.
 *
 * ```ts no_run
 * import { SerialExecutor } from 'internal:serial-executor';
 * const writes = new SerialExecutor({ maxPending: 64 });
 * await writes.run(() => saveChanges());
 * await writes.close();
 * ```
 *
 * @internal
 */

/** Admission policy for a serial executor. */
export interface SerialExecutorOptions {
  /** Maximum accepted operations, including the active one. Defaults to Infinity. */
  maxPending?: number;
}

/** Per-operation cancellation before execution starts. */
export interface SerialRunOptions {
  /** Aborted queued operations reject with the signal's reason and never run. */
  signal?: AbortSignal;
}

interface Entry {
  previous: Entry | null;
  next: Entry | null;
  operation: () => unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  detach: () => void;
}

/**
 * A FIFO gate with one active operation, failure recovery, and explicit shutdown.
 *
 * Admission is synchronous; execution starts in a microtask. Exceeding
 * `maxPending` rejects with RangeError rather than retaining another waiter.
 * State belongs to this instance in this Realm; it is not a cross-Realm lock.
 */
export class SerialExecutor {
  #maxPending: number;
  #pending = 0;
  #closed = false;
  #active = false;
  #head: Entry | null = null;
  #tail: Entry | null = null;
  #idle: Array<() => void> = [];

  /** Create a gate. `maxPending` must be a positive safe integer or Infinity. */
  constructor(options: SerialExecutorOptions = {}) {
    this.#maxPending = options.maxPending ?? Infinity;
    if (
      this.#maxPending !== Infinity &&
      (!Number.isSafeInteger(this.#maxPending) || this.#maxPending < 1)
    )
      throw new RangeError('maxPending must be a positive safe integer or Infinity');
  }

  /** Number of accepted operations that have not settled, including active work. */
  get pending(): number {
    return this.#pending;
  }
  /** Whether admission has been closed. Accepted work may still be running. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Accept an operation and resolve with its result in FIFO order.
   *
   * A thrown or rejected operation does not stop the queue. Cancellation only
   * applies before start; pass the signal into your operation for active work.
   */
  run<T>(operation: () => T | PromiseLike<T>, options: SerialRunOptions = {}): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('SerialExecutor is closed'));
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#pending >= this.#maxPending)
      return Promise.reject(new RangeError('SerialExecutor capacity exceeded'));
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = {
        previous: this.#tail,
        next: null,
        operation,
        resolve: (value) => resolve(value as T),
        reject,
        detach: () => signal?.removeEventListener('abort', abort),
      };
      const abort = () => {
        this.#remove(entry);
        entry.detach();
        this.#pending--;
        reject(signal!.reason);
        this.#notifyIdle();
      };
      if (this.#tail) this.#tail.next = entry;
      else this.#head = entry;
      this.#tail = entry;
      this.#pending++;
      signal?.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => this.#pump());
    });
  }

  #remove(entry: Entry): void {
    if (entry.previous) entry.previous.next = entry.next;
    else this.#head = entry.next;
    if (entry.next) entry.next.previous = entry.previous;
    else this.#tail = entry.previous;
    entry.previous = entry.next = null;
  }
  #pump(): void {
    if (this.#active || !this.#head) return;
    const entry = this.#head;
    this.#remove(entry);
    entry.detach();
    this.#active = true;
    Promise.resolve()
      .then(entry.operation)
      .then(
        (value) => this.#finish(entry, true, value),
        (reason) => this.#finish(entry, false, reason),
      );
  }
  #finish(entry: Entry, success: boolean, value: unknown): void {
    this.#active = false;
    this.#pending--;
    this.#pump();
    if (success) entry.resolve(value);
    else entry.reject(value);
    this.#notifyIdle();
  }
  #notifyIdle(): void {
    if (this.#pending !== 0) return;
    const idle = this.#idle;
    this.#idle = [];
    for (const resolve of idle) resolve();
  }

  /**
   * Wait until the gate becomes idle. New admissions can extend this wait.
   * Operation failures remain on their own promises and do not reject drain.
   */
  drain(): Promise<void> {
    return this.#pending === 0
      ? Promise.resolve()
      : new Promise((resolve) => this.#idle.push(resolve));
  }
  /** Close admission immediately and drain accepted work. Repeated calls are safe. */
  close(): Promise<void> {
    this.#closed = true;
    return this.drain();
  }
  /** Close admission and drain accepted work when leaving an async resource scope. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

/**
 * Independent FIFO gates selected by key, with automatic idle-key eviction.
 *
 * Different keys execute concurrently. `maxPending` applies per key; callers
 * needing a global budget should enforce admission before selecting a key.
 * Keys and operations remain Realm-local and are retained only while pending.
 */
export class KeyedSerialExecutor<K> {
  #executors = new Map<K, SerialExecutor>();
  #options: SerialExecutorOptions;
  #closed = false;
  /** Create keyed gates using the same per-key admission policy. */
  constructor(options: SerialExecutorOptions = {}) {
    // Validate eagerly and snapshot options rather than retaining mutable input.
    new SerialExecutor(options);
    this.#options = { maxPending: options.maxPending ?? Infinity };
  }
  /** Number of keys with accepted work that has not settled. */
  get size(): number {
    return this.#executors.size;
  }
  /** Whether admission has been closed for every key. */
  get closed(): boolean {
    return this.#closed;
  }
  /** Serialize an operation with others sharing its key, preserving its outcome. */
  run<T>(key: K, operation: () => T | PromiseLike<T>, options: SerialRunOptions = {}): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('KeyedSerialExecutor is closed'));
    let executor = this.#executors.get(key);
    if (!executor) {
      executor = new SerialExecutor(this.#options);
      this.#executors.set(key, executor);
    }
    const current = executor;
    return current.run(operation, options).finally(() => {
      if (current.pending === 0 && this.#executors.get(key) === current)
        this.#executors.delete(key);
    });
  }
  /**
   * Wait for keys present at the call to become idle. Later work on those keys
   * can extend the wait; newly introduced keys are not included.
   */
  async drain(): Promise<void> {
    await Promise.all([...this.#executors.values()].map((executor) => executor.drain()));
  }
  /** Close all admission immediately and drain every accepted operation. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#executors.values()].map((executor) => executor.close()));
  }
  /** Close admission and drain all keys when leaving an async resource scope. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
