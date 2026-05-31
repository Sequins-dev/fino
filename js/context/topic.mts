/**
 * fino:topic — Named pub/sub channels with Context binding.
 *
 * A `Topic` is a named pub/sub channel. When a `Context` is bound to a Topic,
 * calling `topic.runWithValue(msg, fn)` automatically derives and installs the
 * bound context value for the duration of `fn`. This separates the concerns of
 * *publishing* (the library/framework) from *consuming* context (application code).
 *
 * ```ts
 *   import { topic } from './topic.mts';
 *   import { Context } from 'fino:context';
 *
 *   const requestCtx = new Context('request');
 *   const httpTopic = topic('http.request');
 *
 *   httpTopic.bindContext(requestCtx, (req) => req);
 *
 *   // In a handler:
 *   httpTopic.runWithValue(request, () => {
 *     // requestCtx.get() === request here, and in any awaited code
 *     handleRequest();
 *   });
 * ```
 */

// ---------------------------------------------------------------------------
// Global topic registry (get-or-create by name)
// ---------------------------------------------------------------------------

const registry = new Map<string, Topic<any>>();
const topicCreationSubscribers = new Map<symbol, (name: string, topic: Topic<unknown>) => void>();

/**
 * Get or create a named `Topic`. Topics with the same name share state across
 * all imports — useful for cross-cutting bindings between libraries.
 *
 * @param {string} name
 * @returns {Topic}
 */
export function topic<T = unknown>(name: string): Topic<T> {
  let t = registry.get(name);
  if (t === undefined) {
    t = new Topic(name);
    registry.set(name, t);
    for (const subscriber of topicCreationSubscribers.values()) subscriber(name, t);
  }
  return t;
}

export function subscribeMatching<T = unknown>(
  matcher: (name: string) => boolean,
  fn: (msg: T, topicName: string) => void,
): SubscriptionHandle {
  const handles = new Map<string, SubscriptionHandle>();

  function attach(name: string, currentTopic: Topic<unknown>) {
    if (!matcher(name) || handles.has(name)) return;
    handles.set(
      name,
      currentTopic.subscribe((msg) => {
        fn(msg as T, name);
      }),
    );
  }

  for (const [name, currentTopic] of registry.entries()) attach(name, currentTopic);

  const creationId = Symbol();
  topicCreationSubscribers.set(creationId, attach);

  return new SubscriptionHandle(function unsubscribeMatching() {
    topicCreationSubscribers.delete(creationId);
    for (const handle of handles.values()) handle.dispose();
    handles.clear();
  });
}

// ---------------------------------------------------------------------------
// Topic
// ---------------------------------------------------------------------------

export class Topic<T = unknown> {
  #name: string;
  #subscribers: Map<symbol, (msg: T) => void> = new Map();
  #bindings: Array<{ ctx: { runWithValue<R>(val: any, fn: () => R): R }; transform: (msg: T) => unknown }> = [];

  /**
   * @param {string} name
   */
  constructor(name: string) {
    this.#name = name;
  }

  /** The topic name (readonly). */
  get name(): string {
    return this.#name;
  }

  /** `true` if there are any active subscribers. */
  get hasSubscribers(): boolean {
    return this.#subscribers.size > 0;
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  /**
   * Register a subscriber callback. Returns a `SubscriptionHandle` with a
   * `dispose()` method to remove the subscription.
   *
   * The same function can be subscribed multiple times; each call returns an
   * independent handle.
   *
   * @param {(msg: any) => void} fn
   * @returns {SubscriptionHandle}
   */
  subscribe(fn: (msg: T) => void): SubscriptionHandle {
    const id = Symbol();
    this.#subscribers.set(id, fn);
    const subscribers = this.#subscribers;
    return new SubscriptionHandle(function unsubscribe() { subscribers.delete(id); });
  }

  /**
   * Remove a subscription via its handle.
   *
   * @param {SubscriptionHandle} handle
   */
  unsubscribe(handle: SubscriptionHandle): void {
    handle.dispose();
  }

  /**
   * Async iterator — consume published messages with `for await`.
   *
   * Each `for await` call creates an independent iterator with its own
   * internal queue. Messages published while the consumer is busy are
   * buffered in order and delivered on the next `next()` call. Breaking
   * out of the loop (or calling `return()` on the iterator) disposes the
   * subscription automatically.
   *
   * ```ts
   * for await (const { signal } of signal('SIGTERM')) {
   *   console.log('received', signal);
   *   break; // disposes the subscription
   * }
   * ```
   */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    const queue: T[] = [];
    let pending: ((result: IteratorResult<T>) => void) | null = null;
    let done = false;

    const handle = this.subscribe(function onTopicMessage(msg) {
      if (pending !== null) {
        const resolve = pending;
        pending = null;
        resolve({ value: msg, done: false });
      } else {
        queue.push(msg);
      }
    });

    return {
      next(): Promise<IteratorResult<T>> {
        if (queue.length > 0) {
          return Promise.resolve({ value: queue.shift()!, done: false });
        }
        if (done) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise(function waitForMessage(resolve) { pending = resolve; });
      },
      return(): Promise<IteratorResult<T>> {
        done = true;
        handle.dispose();
        if (pending !== null) {
          const resolve = pending;
          pending = null;
          resolve({ value: undefined as unknown as T, done: true });
        }
        return Promise.resolve({ value: undefined as unknown as T, done: true });
      },
    };
  }

  /**
   * Fire all subscribers with `msg`. Each subscriber runs in its own
   * try/catch; errors are forwarded to the `"execution-flow:error"` topic so
   * a failing subscriber never blocks delivery to others.
   *
   * Note: does NOT enter bound context scopes. Use `runWithValue()` for that.
   *
   * @param {*} msg
   */
  publish(msg: T): void {
    if (!this.hasSubscribers) return;
    for (const fn of this.#subscribers.values()) {
      try {
        fn(msg);
      } catch (err) {
        if (this.#name !== 'execution-flow:error') {
          try {
            topic('execution-flow:error').publish({
              error: err instanceof Error ? err : new Error(String(err)),
              topicName: this.#name,
            });
          } catch (_) {
            // swallow to prevent infinite recursion
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Context bindings
  // -------------------------------------------------------------------------

  /**
   * Declare that when this topic fires via `runWithValue()`, `ctx` should
   * be set to `transform(msg)` for the duration of the call. Multiple bindings
   * are entered in registration order (outermost first) and restored in reverse.
   *
   * @param {import('./index.mts').Context} ctx
   * @param {(msg: any) => any} transform
   * @returns {BindingHandle}
   */
  bindContext<C>(ctx: { runWithValue<R>(val: C, fn: () => R): R }, transform: (msg: T) => C): BindingHandle {
    const binding = { ctx, transform };
    this.#bindings.push(binding);
    const bindings = this.#bindings;
    return new BindingHandle(function removeBinding() {
      const i = bindings.indexOf(binding);
      if (i !== -1) bindings.splice(i, 1);
    });
  }

  /**
   * Remove a context binding via its handle.
   *
   * @param {BindingHandle} handle
   */
  unbindContext(handle: BindingHandle): void {
    handle.dispose();
  }

  /**
   * Enter all bound context scopes (in registration order), publish `msg` to
   * subscribers, then run `fn` — all within those scopes. Context values are
   * derived by calling each binding's `transform(msg)`. Scopes are restored in
   * reverse order after `fn` returns or throws.
   *
   * @param {*}        msg
   * @param {Function} fn
   * @returns The return value of `fn`.
   */
  runWithValue<R>(msg: T, fn: () => R): R {
    return this.#runWithBindings(msg, 0, fn);
  }

  // Enter bindings[index..] recursively so that each binding's runWithValue
  // restores cleanly even when fn throws.
  #runWithBindings<R>(msg: T, index: number, fn: () => R): R {
    if (index >= this.#bindings.length) {
      this.publish(msg);
      return fn();
    }
    const binding = this.#bindings[index];
    if (binding === undefined) return fn();
    const { ctx, transform } = binding;
    const self = this;
    return ctx.runWithValue(transform(msg), function runNextBinding() {
      return self.#runWithBindings(msg, index + 1, fn);
    });
  }
}

// ---------------------------------------------------------------------------
// Handle types
// ---------------------------------------------------------------------------

export class SubscriptionHandle {
  #dispose: () => void;

  constructor(disposeFn: () => void) {
    this.#dispose = disposeFn;
  }

  dispose(): void {
    this.#dispose();
  }
}

export class BindingHandle {
  #dispose: () => void;

  constructor(disposeFn: () => void) {
    this.#dispose = disposeFn;
  }

  dispose(): void {
    this.#dispose();
  }
}
