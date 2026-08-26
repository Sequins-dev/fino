/**
 * Asynchronous completion output with bounded task admission.
 *
 * `claim()` immediately reserves the next position in the output sequence.
 * Calling `schedule()` on that resolver waits for its optional readiness
 * dependency and an execution slot. Settling a scheduled resolver releases its
 * slot immediately. Iteration yields values in completion order by default;
 * callers may request claim order when reproducible output is more important
 * than immediately exposing completed work.
 *
 * @internal
 */

/** A claimed output position whose work can be admitted and settled once. @internal */
export interface ConcurrentTaskResolver<T> {
  /** Zero-based position assigned synchronously by `claim()`. */
  readonly index: number;
  /** Wait until ready and admitted; exclusive tasks reserve the full capacity. */
  schedule(options?: { exclusive?: boolean; ready?: PromiseLike<unknown> }): Promise<void>;
  /** Fill this position with a value and release its execution slot. */
  resolve(value: T): void;
  /** Fill this position with a rejection and release its execution slot. */
  reject(reason?: unknown): void;
}

interface ScheduleWaiter {
  index: number;
  weight: number;
  ready: boolean;
  resolve(): void;
}

interface ReadWaiter<T> {
  resolve(result: IteratorResult<T>): void;
  reject(reason?: unknown): void;
}

type Entry<T> =
  | { state: 'claimed' }
  | { state: 'scheduled'; weight: number }
  | { state: 'fulfilled'; value: T }
  | { state: 'rejected'; reason: unknown };

/** Output ordering policy for a concurrent task channel. @internal */
export interface ConcurrentTaskChannelOptions {
  /** Yield settled tasks immediately, or wait for earlier claims. */
  outputOrder?: 'completion' | 'claim';
}

/**
 * An async sequence backed by a bounded number of scheduled tasks.
 *
 * Claims synchronously reserve output positions without consuming execution
 * capacity. Among ready schedule requests, claims are admitted in their request
 * order; a request waiting on a dependency is skipped without consuming a
 * slot. An exclusive request is a barrier even while its dependency is pending;
 * it waits for every active task and blocks later requests until it can reserve
 * the full channel. A fulfilled or rejected
 * resolver frees its capacity slot even when an earlier position is still
 * pending, allowing execution to remain bounded without coupling it to output
 * ordering. Results yield in completion order unless `outputOrder: 'claim'`
 * is requested. Call `close()` after the final claim; iteration finishes once
 * all claimed positions have been scheduled, settled, and consumed.
 *
 * @internal
 */
export class ConcurrentTaskChannel<T> implements AsyncIterableIterator<T> {
  readonly #capacity: number;
  readonly #outputOrder: 'completion' | 'claim';
  #active = 0;
  #claimed = 0;
  #nextOutput = 0;
  #consumed = 0;
  #closed = false;
  readonly #entries = new Map<number, Entry<T>>();
  readonly #settledOrder: number[] = [];
  readonly #scheduleWaiters: ScheduleWaiter[] = [];
  readonly #readWaiters: ReadWaiter<T>[] = [];

  constructor(capacity: number, options: ConcurrentTaskChannelOptions = {}) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('ConcurrentTaskChannel capacity must be a positive integer');
    }
    this.#capacity = capacity;
    this.#outputOrder = options.outputOrder ?? 'completion';
  }

  /** Maximum number of scheduled, unsettled tasks. */
  get capacity(): number {
    return this.#capacity;
  }

  /** Number of scheduled tasks that have not settled. */
  get active(): number {
    return this.#active;
  }

  /**
   * Immediately claim the next output position.
   *
   * Claiming does not consume execution capacity. Use the returned resolver's
   * `schedule()` method when the task is ready for admission. Claims made after
   * `close()` throw.
   */
  claim(): ConcurrentTaskResolver<T> {
    if (this.#closed) throw new Error('ConcurrentTaskChannel is closed');
    const index = this.#claimed++;
    this.#entries.set(index, { state: 'claimed' });
    let schedulePromise: Promise<void> | undefined;
    let settled = false;

    const schedule = (
      options: { exclusive?: boolean; ready?: PromiseLike<unknown> } = {},
    ): Promise<void> => {
      if (schedulePromise) return schedulePromise;
      if (settled) throw new Error('ConcurrentTaskChannel resolver is already settled');
      schedulePromise = new Promise<void>((resolve) => {
        const waiter: ScheduleWaiter = {
          index,
          weight: options.exclusive === true ? this.#capacity : 1,
          ready: options.ready === undefined,
          resolve,
        };
        this.#scheduleWaiters.push(waiter);
        if (options.ready !== undefined) {
          void Promise.resolve(options.ready).then(
            () => {
              waiter.ready = true;
              this.#drainSchedules();
            },
            () => {
              waiter.ready = true;
              this.#drainSchedules();
            },
          );
        }
      });
      this.#drainSchedules();
      return schedulePromise;
    };

    const settle = (entry: Entry<T>) => {
      if (settled) return;
      const current = this.#entries.get(index);
      if (current?.state !== 'scheduled') {
        throw new Error('ConcurrentTaskChannel resolver must be scheduled before settlement');
      }
      settled = true;
      this.#entries.set(index, entry);
      if (this.#outputOrder === 'completion') this.#settledOrder.push(index);
      this.#active -= current.weight;
      this.#drainSchedules();
      this.#drainReads();
    };

    return {
      index,
      schedule,
      resolve: (value) => settle({ state: 'fulfilled', value }),
      reject: (reason) => settle({ state: 'rejected', reason }),
    };
  }

  /** Stop accepting claims and finish iteration after existing claims drain. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#drainReads();
  }

  next(): Promise<IteratorResult<T>> {
    const promise = new Promise<IteratorResult<T>>((resolve, reject) => {
      this.#readWaiters.push({ resolve, reject });
    });
    this.#drainReads();
    return promise;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  #drainSchedules(): void {
    while (this.#active < this.#capacity && this.#scheduleWaiters.length > 0) {
      let waiterIndex = -1;
      for (let index = 0; index < this.#scheduleWaiters.length; index++) {
        const waiter = this.#scheduleWaiters[index]!;
        if (waiter.ready) {
          waiterIndex = index;
          break;
        }
        if (waiter.weight === this.#capacity) return;
      }
      if (waiterIndex < 0) return;
      const waiter = this.#scheduleWaiters[waiterIndex]!;
      if (this.#active + waiter.weight > this.#capacity) return;
      this.#scheduleWaiters.splice(waiterIndex, 1);
      const entry = this.#entries.get(waiter.index);
      if (entry?.state !== 'claimed') continue;
      this.#entries.set(waiter.index, { state: 'scheduled', weight: waiter.weight });
      this.#active += waiter.weight;
      waiter.resolve();
    }
  }

  #drainReads(): void {
    while (this.#readWaiters.length > 0) {
      const index = this.#outputOrder === 'claim' ? this.#nextOutput : this.#settledOrder.shift();
      const entry = index === undefined ? undefined : this.#entries.get(index);
      if (entry?.state === 'fulfilled') {
        this.#entries.delete(index!);
        this.#consumed++;
        if (this.#outputOrder === 'claim') this.#nextOutput++;
        this.#readWaiters.shift()!.resolve({ value: entry.value, done: false });
        continue;
      }
      if (entry?.state === 'rejected') {
        this.#entries.delete(index!);
        this.#consumed++;
        if (this.#outputOrder === 'claim') this.#nextOutput++;
        this.#readWaiters.shift()!.reject(entry.reason);
        continue;
      }
      if (index !== undefined && this.#outputOrder === 'completion') {
        this.#settledOrder.unshift(index);
      }
      if (this.#closed && this.#consumed === this.#claimed) {
        this.#readWaiters.shift()!.resolve({ value: undefined, done: true });
        continue;
      }
      return;
    }
  }
}
