/**
 * fino:signals — retained reactive values for runtime read models.
 *
 * Signals model state: the latest value is retained, subscribers are notified
 * when that value changes, and `Object.is` skips redundant writes. They are a
 * good fit for UI render dependencies, queue statistics, run status, counters,
 * and other "what is true now" views. They are not an event log; streams,
 * topics, and async iterators remain the right surface when every intermediate
 * value matters.
 *
 * ## Design
 *
 * Writable `Signal` instances are owned by producers. Public APIs should expose
 * `ReadonlySignal` when consumers must observe but not update the value.
 * `batch()` coalesces synchronous writes into one notification pass, while
 * `computed()` and `effect()` use `observeReads()` to track whichever signals
 * were read on the latest run.
 *
 * `lazy()` and `fromIterable()` are cold bridges: upstream work starts only
 * when the first subscriber attaches and is disposed after the last subscriber
 * leaves. The current value remains readable even while the producer is cold.
 *
 * ```ts no_run
 * import { computed, createSignal, effect } from 'fino:signals';
 *
 * const count = createSignal(0);
 * const doubled = computed(() => count.get() * 2);
 *
 * const stop = effect(() => {
 *   console.log(doubled.get());
 * });
 *
 * count.set(2);
 * stop();
 * ```
 */

/**
 * Callback invoked after a signal value changes.
 *
 * The callback receives the current value and the previous value. Batched
 * writes call subscribers once with the value before the first write and the
 * final value after the outermost batch completes.
 */
export type SignalSubscriber<T> = (value: T, previous: T) => void;

/**
 * Value or updater accepted by `Signal.set()`.
 */
export type SignalSetter<T> = T | ((value: T) => T);

/**
 * Read-only signal handle for consumers.
 *
 * A `ReadonlySignal` exposes the current value and change notifications but
 * does not allow callers to write. Producers should prefer this shape for
 * public runtime read models.
 */
export interface ReadonlySignal<T> {
  /** Return the current retained value. */
  get(): T;
  /**
   * Subscribe to future value changes.
   *
   * The callback is not called immediately. The returned function removes the
   * subscription and is safe to call more than once.
   */
  subscribe(subscriber: SignalSubscriber<T>): () => void;
}

/**
 * Result returned by `observeReads()`.
 */
export interface ObservedReads<T> {
  /** Value returned by the observed callback. */
  value: T;
  /** Unique signals read while the callback ran, in first-read order. */
  signals: ReadonlySignal<unknown>[];
}

type ReadObserver = (signal: ReadonlySignal<unknown>) => void;

/**
 * Callback consulted before a signal write is applied.
 *
 * A guard that throws rejects the write. Guards see only writes that change the
 * value, so a redundant `set()` never trips one.
 */
export type WriteGuard = (signal: ReadonlySignal<unknown>) => void;

let batchDepth = 0;
const pendingSignals = new Set<Signal<unknown>>();
const readObservers: ReadObserver[] = [];
const writeGuards: WriteGuard[] = [];

function currentReadObserver(): ReadObserver | undefined {
  return readObservers[readObservers.length - 1];
}

function currentWriteGuard(): WriteGuard | undefined {
  return writeGuards[writeGuards.length - 1];
}

/**
 * Run `fn` with `guard` consulted before every value-changing signal write.
 *
 * This is the low-level hook behind one-shot renderers, which treat state
 * mutation during a pass as a bug rather than a re-render trigger. Only
 * synchronous writes made during `fn` are seen; work deferred to a later turn
 * runs outside the guard.
 */
export function withWriteGuard<T>(guard: WriteGuard, fn: () => T): T {
  writeGuards.push(guard);
  try {
    return fn();
  } finally {
    writeGuards.pop();
  }
}

function flushSignals(): void {
  const pending = Array.from(pendingSignals);
  pendingSignals.clear();
  for (const signal of pending) signal.flush();
}

/**
 * Run multiple signal writes as one notification pass.
 *
 * Subscribers are called after the outermost batch completes, and each changed
 * signal notifies at most once with its final value.
 */
export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) flushSignals();
  }
}

/**
 * Explicit mutable reactive value.
 *
 * Use `get()` to read the retained value, `set()` to replace or derive the
 * next value, and `subscribe()` to observe later changes. Redundant writes are
 * skipped with `Object.is`.
 */
export class Signal<T> implements ReadonlySignal<T> {
  #value: T;
  #previous: T;
  #dirty = false;
  #subscribers = new Set<SignalSubscriber<T>>();

  constructor(initial: T) {
    this.#value = initial;
    this.#previous = initial;
  }

  /** Return the current signal value and record the read when observed. */
  get(): T {
    currentReadObserver()?.(this as ReadonlySignal<unknown>);
    return this.#value;
  }

  /**
   * Replace the value or derive the next value from the current one.
   *
   * Subscribers are skipped when `Object.is(previous, next)` is true.
   */
  set(next: SignalSetter<T>): void {
    const previous = this.#value;
    const value = typeof next === 'function' ? (next as (value: T) => T)(previous) : next;
    if (Object.is(previous, value)) return;
    currentWriteGuard()?.(this as ReadonlySignal<unknown>);
    if (!this.#dirty) this.#previous = previous;
    this.#value = value;
    this.#dirty = true;
    if (batchDepth > 0) {
      pendingSignals.add(this as Signal<unknown>);
    } else {
      this.flush();
    }
  }

  /**
   * Subscribe to value changes.
   *
   * The returned function removes the subscriber. Subscriptions do not fire
   * immediately; they only observe subsequent writes.
   */
  subscribe(subscriber: SignalSubscriber<T>): () => void {
    this.#subscribers.add(subscriber);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#subscribers.delete(subscriber);
    };
  }

  /** @internal Flush one pending notification pass. */
  flush(): void {
    if (!this.#dirty) return;
    this.#dirty = false;
    const previous = this.#previous;
    const value = this.#value;
    for (const subscriber of Array.from(this.#subscribers)) subscriber(value, previous);
  }
}

/**
 * Create a writable signal with explicit `get`, `set`, and `subscribe` methods.
 */
export function createSignal<T>(initial: T): Signal<T> {
  return new Signal(initial);
}

/**
 * Run `fn` and return the signals read during that run.
 *
 * This is the low-level hook used by renderers and reactive helpers. Nested
 * calls are isolated, and duplicate reads of the same signal are reported once.
 */
export function observeReads<T>(fn: () => T): ObservedReads<T> {
  const seen = new Set<ReadonlySignal<unknown>>();
  const signals: ReadonlySignal<unknown>[] = [];
  readObservers.push((signal) => {
    if (seen.has(signal)) return;
    seen.add(signal);
    signals.push(signal);
  });
  try {
    return {
      value: fn(),
      signals,
    };
  } finally {
    readObservers.pop();
  }
}

function subscribeAll(signals: ReadonlySignal<unknown>[], fn: () => void): () => void {
  const disposers = signals.map((signal) => signal.subscribe(fn));
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const dispose of disposers) dispose();
  };
}

/**
 * Create a read-only signal derived from other signals.
 *
 * The derivation runs immediately, then re-runs whenever any signal read during
 * the latest run changes. Conditional dependencies are re-tracked each time.
 */
export function computed<T>(fn: () => T): ReadonlySignal<T> {
  const out = createSignal<T>(undefined as T);
  let disposeDeps: (() => void) | undefined;
  let running = false;
  const rerun = () => {
    if (running) return;
    running = true;
    try {
      disposeDeps?.();
      const observed = observeReads(fn);
      out.set(observed.value);
      disposeDeps = subscribeAll(observed.signals, rerun);
    } finally {
      running = false;
    }
  };
  rerun();
  return out;
}

/**
 * Run a side effect now and whenever its read dependencies change.
 *
 * The returned function disposes the current dependencies and prevents future
 * re-runs. Dependencies are re-tracked on every execution.
 */
export function effect(fn: () => void): () => void {
  let disposeDeps: (() => void) | undefined;
  let disposed = false;
  let running = false;
  const rerun = () => {
    if (disposed || running) return;
    running = true;
    try {
      disposeDeps?.();
      const observed = observeReads(fn);
      disposeDeps = subscribeAll(observed.signals, rerun);
    } finally {
      running = false;
    }
  };
  rerun();
  return () => {
    if (disposed) return;
    disposed = true;
    disposeDeps?.();
    disposeDeps = undefined;
  };
}

class LazySignal<T> implements ReadonlySignal<T> {
  #inner: Signal<T>;
  #start: (set: (value: T) => void) => () => void;
  #stop: (() => void) | undefined;
  #subscribers = 0;

  constructor(initial: T, start: (set: (value: T) => void) => () => void) {
    this.#inner = createSignal(initial);
    this.#start = start;
  }

  get(): T {
    return this.#inner.get();
  }

  subscribe(subscriber: SignalSubscriber<T>): () => void {
    const disposeInner = this.#inner.subscribe(subscriber);
    this.#subscribers++;
    if (this.#subscribers === 1) {
      this.#stop = this.#start((value) => this.#inner.set(value));
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      disposeInner();
      this.#subscribers--;
      if (this.#subscribers === 0) {
        const stop = this.#stop;
        this.#stop = undefined;
        stop?.();
      }
    };
  }
}

/**
 * Create a cold read-only signal.
 *
 * `start` is called when the first subscriber attaches. It receives a setter for
 * publishing retained values and returns a cleanup callback, which runs after
 * the last subscriber unsubscribes.
 */
export function lazy<T>(
  initial: T,
  start: (set: (value: T) => void) => () => void,
): ReadonlySignal<T> {
  return new LazySignal(initial, start);
}

/**
 * Fold an async iterable into a cold retained signal.
 *
 * The iterable is consumed only while the signal has subscribers. On teardown,
 * the active iterator's `return()` method is called when present so upstream
 * subscriptions and readers can release resources.
 */
export function fromIterable<T, S>(
  src: AsyncIterable<T>,
  fold: (acc: S, item: T) => S,
  initial: S,
): ReadonlySignal<S> {
  let current = initial;
  return lazy(initial, (set) => {
    let active = true;
    const iterator = src[Symbol.asyncIterator]();
    void (async () => {
      try {
        while (active) {
          const next = await iterator.next();
          if (next.done) break;
          current = fold(current, next.value);
          set(current);
        }
      } catch {
        // Signals have no error channel. Consumers that need every failure
        // should observe the source iterable directly.
      }
    })();
    return () => {
      active = false;
      void iterator.return?.();
    };
  });
}
