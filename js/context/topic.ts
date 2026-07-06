/**
* fino:context/topic - Named pub/sub channels with Context binding.
*
* A `Topic` is a named pub/sub channel. `topic(name)` gets or creates one in a
* process-wide registry, so independently loaded modules that use the same
* name share the same channel - the basis for cross-cutting concerns such as
* logging, tracing, and diagnostics. Delivery is synchronous: `publish()`
* calls every subscriber before returning, isolating each in its own
* try/catch and forwarding failures to the `execution-flow:error` topic so
* one bad subscriber never starves the rest. Topics are also async iterable,
* so a consumer can `for await` messages with per-iterator buffering.
*
* When a `Context` is bound to a Topic, calling `topic.runWithValue(msg, fn)`
* automatically derives and installs the bound context value for the duration
* of `fn`. This separates the concerns of *publishing* (the library/framework)
* from *consuming* context (application code): the publisher never needs to
* know which contexts downstream code cares about.
*
* ```ts no_run
*   import { topic } from 'fino:context/topic';
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
import type { Context } from './index.ts';
// ---------------------------------------------------------------------------
// Global topic registry (get-or-create by name)
// ---------------------------------------------------------------------------
const registry = new Map<string, Topic<any>>();
const topicCreationSubscribers = new Map<symbol, (name: string, topic: Topic<unknown>) => void>();
/**
* Get or create a named `Topic`. Topics with the same name share state across
* all imports - useful for cross-cutting bindings between libraries.
*
* A new topic starts with no subscribers and no context bindings. The function
* never returns `null`; invalid or empty names are accepted as ordinary map
* keys, so choose stable names such as `package:event`.
*
* ```ts no_run
* import { topic } from 'fino:context/topic';
*
* const requests = topic<{ id: string }>('http:request');
* requests.publish({ id: 'req-1' });
* ```
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
/**
* Subscribe to all existing and future topics whose names match `matcher`.
*
* The matcher is evaluated for topics already in the registry and for each
* topic created later. The callback receives every published message along
* with the name of the topic it came from, so one callback can fan in a
* whole family of topics. Callback errors are handled by the matched
* topic's normal `publish()` error path. Returns a handle that removes
* every attached subscription (and stops watching for new topics) when
* disposed.
*
* ```ts no_run
* import { subscribeMatching, topic } from 'fino:context/topic';
*
* const handle = subscribeMatching(
*   (name) => name.startsWith('audit:'),
*   (event, topicName) => console.log(topicName, event),
* );
* topic('audit:login').publish({ user: 'ana' });
* handle.dispose();
* ```
*/
export function subscribeMatching<T = unknown>(matcher: (name: string) => boolean, fn: (msg: T, topicName: string) => void): SubscriptionHandle {
  const handles = new Map<string, SubscriptionHandle>();
  function attach(name: string, currentTopic: Topic<unknown>) {
    if (!matcher(name) || handles.has(name)) return;
    handles.set(name, currentTopic.subscribe((msg) => {
      fn(msg as T, name);
    }));
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
/**
* Named publish/subscribe channel that can bind messages into async contexts.
*
* Topics deliver messages synchronously to current subscribers. Use
* `runWithValue()` when subscribers and a callback should execute with context
* values derived from the message.
*
* ```ts no_run
* import { topic } from 'fino:context/topic';
*
* const updates = topic<string>('status:update');
* updates.subscribe((message) => console.log(message));
* updates.publish('ready');
* ```
*/
export class Topic<T = unknown> {
  /**
  * Topic name fixed at construction. Exposed via the `name` getter and used
  * as the registry lookup key for topics created through `topic()`.
  *
  * @internal
  */
  #name: string;
  /**
  * Active subscriber callbacks keyed by a per-subscription symbol, so the
  * same function can be subscribed multiple times and each subscription can
  * be disposed independently.
  *
  * @internal
  */
  #subscribers: Map<symbol, (msg: T) => void> = new Map();
  /**
  * Registered context bindings in registration order. Each entry pairs a
  * context-like object with the transform that derives the context value
  * from a published message; `runWithValue()` enters them outermost-first.
  *
  * @internal
  */
  #bindings: Array<{
    ctx: {
      runWithValue<R>(val: any, fn: () => R): R;
    };
    transform: (msg: T) => unknown;
  }> = [];
  /**
  * Create an unregistered topic instance.
  *
  * Direct construction is useful for private channels. Use `topic(name)` when
  * other modules should retrieve the same shared instance by name.
  *
  * ```ts no_run
  * import { Topic } from 'fino:context/topic';
  *
  * const privateTopic = new Topic<number>('local:count');
  * privateTopic.publish(1);
  * ```
  */
  constructor(name: string) {
    this.#name = name;
  }
  /**
  * Read the topic name.
  *
  * The name is not required to be globally unique for directly constructed
  * topics, but registry-created topics use it as their lookup key.
  *
  * ```ts no_run
  * import { topic } from 'fino:context/topic';
  *
  * console.log(topic('metrics:tick').name);
  * ```
  */
  get name(): string {
    return this.#name;
  }
  /**
  * Report whether the topic currently has one or more subscribers.
  *
  * This is a synchronous snapshot. It may be used to avoid constructing
  * expensive messages, but a subscriber can still be added or disposed
  * immediately after the check.
  *
  * ```ts no_run
  * import { topic } from 'fino:context/topic';
  *
  * const events = topic('metrics:event');
  * if (events.hasSubscribers) events.publish({ count: 1 });
  * ```
  */
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
  * Delivery is synchronous during `publish()` and `runWithValue()`. A thrown
  * subscriber error is forwarded to the `execution-flow:error` topic and does
  * not prevent later subscribers from receiving the same message.
  *
  * ```ts no_run
  * import { topic } from 'fino:context/topic';
  *
  * const messages = topic<string>('chat:message');
  * const handle = messages.subscribe((message) => console.log(message));
  * handle.dispose();
  * ```
  */
  subscribe(fn: (msg: T) => void): SubscriptionHandle {
    const id = Symbol();
    this.#subscribers.set(id, fn);
    const subscribers = this.#subscribers;
    return new SubscriptionHandle(function unsubscribe() {
      subscribers.delete(id);
    });
  }
  /**
  * Remove a subscription via its handle.
  *
  * This is equivalent to calling `handle.dispose()`. Passing a handle from a
  * different topic is harmless when the handle itself is still valid because
  * handles close over their own removal logic.
  *
  * ```ts no_run
  * import { topic } from 'fino:context/topic';
  *
  * const events = topic('app:event');
  * const handle = events.subscribe(() => {});
  * events.unsubscribe(handle);
  * ```
  */
  unsubscribe(handle: SubscriptionHandle): void {
    handle.dispose();
  }
  /**
  * Async iterator - consume published messages with `for await`.
  *
  * Each `for await` call creates an independent iterator with its own
  * internal queue. Messages published while the consumer is busy are
  * buffered in order and delivered on the next `next()` call. Breaking
  * out of the loop (or calling `return()` on the iterator) disposes the
  * subscription automatically.
  *
  * ```ts no_run
  * import { topic } from 'fino:context/topic';
  *
  * const events = topic<string>('worker:event');
  * for await (const event of events) {
  *   console.log('received', event);
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
        resolve({
          value: msg,
          done: false
        });
      } else {
        queue.push(msg);
      }
    });
    return {
      next(): Promise<IteratorResult<T>> {
        if (queue.length > 0) {
          return Promise.resolve({
            value: queue.shift()!,
            done: false
          });
        }
        if (done) {
          return Promise.resolve({
            value: (undefined as unknown) as T,
            done: true
          });
        }
        return new Promise(function waitForMessage(resolve) {
          pending = resolve;
        });
      },
      return(): Promise<IteratorResult<T>> {
        done = true;
        queue.length = 0;
        handle.dispose();
        if (pending !== null) {
          const resolve = pending;
          pending = null;
          resolve({
            value: (undefined as unknown) as T,
            done: true
          });
        }
        return Promise.resolve({
          value: (undefined as unknown) as T,
          done: true
        });
      }
    };
  }
  /**
  * Fire all subscribers with `msg`. Each subscriber runs in its own
  * try/catch; errors are forwarded to the `"execution-flow:error"` topic so
  * a failing subscriber never blocks delivery to others.
  *
  * Note: does NOT enter bound context scopes. Use `runWithValue()` for that.
  *
  * Publishing to a topic with no subscribers is a no-op. Messages are passed
  * by reference; mutating an object in one subscriber affects later
  * subscribers that receive the same object.
  *
  * ```ts no_run
  * import { topic } from 'fino:context/topic';
  *
  * const events = topic<{ ok: boolean }>('service:event');
  * events.subscribe((event) => console.log(event.ok));
  * events.publish({ ok: true });
  * ```
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
              topicName: this.#name
            });
          } catch (_) {}
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
  * Anything with a `runWithValue(value, fn)` method works as the binding
  * target, though `Context` from `fino:context` is the usual choice. The
  * returned handle removes the binding when disposed; `publish()` alone
  * never enters bound scopes.
  *
  * ```ts no_run
  * import { Context } from 'fino:context';
  * import { topic } from 'fino:context/topic';
  *
  * const requestId = new Context<string>('requestId');
  * const requests = topic<{ id: string }>('http:request');
  * const binding = requests.bindContext(requestId, (request) => request.id);
  * binding.dispose();
  * ```
  */
  bindContext<C>(ctx: {
    runWithValue<R>(val: C, fn: () => R): R;
  }, transform: (msg: T) => C): BindingHandle {
    const binding = {
      ctx,
      transform
    };
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
  * This is equivalent to calling `handle.dispose()`. Once removed, future
  * `runWithValue()` calls no longer enter the associated context.
  *
  * ```ts no_run
  * import { Context } from 'fino:context';
  * import { topic } from 'fino:context/topic';
  *
  * const ctx = new Context<string>('tenant');
  * const events = topic<{ tenant: string }>('tenant:event');
  * const handle = events.bindContext(ctx, (event) => event.tenant);
  * events.unbindContext(handle);
  * ```
  */
  unbindContext(handle: BindingHandle): void {
    handle.dispose();
  }
  /**
  * Enter all bound context scopes (in registration order), publish `msg` to
  * subscribers, then run `fn` - all within those scopes. Context values are
  * derived by calling each binding's `transform(msg)`. Scopes are restored in
  * reverse order after `fn` returns or throws, and the return value of `fn`
  * is passed through.
  *
  * ```ts no_run
  * import { Context } from 'fino:context';
  * import { topic } from 'fino:context/topic';
  *
  * const ctx = new Context<string>('requestId');
  * const requests = topic<{ id: string }>('http:request');
  * requests.bindContext(ctx, (request) => request.id);
  * requests.runWithValue({ id: 'req-1' }, () => console.log(ctx.get()));
  * ```
  */
  runWithValue<R>(msg: T, fn: () => R): R {
    return this.#runWithBindings(msg, 0, fn);
  }
  // Enter bindings[index..] recursively so that each binding's runWithValue
  // restores cleanly even when fn throws.
  /**
  * Recursively enter `#bindings[index..]` so each binding's `runWithValue`
  * frame restores its context cleanly even when `fn` throws, then publish
  * `msg` and invoke `fn` inside the innermost scope.
  *
  * @internal
  */
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
/**
* Disposable handle returned from topic subscriptions.
*
* Disposing removes the callback from the topic that created the handle. The
* current implementation tolerates repeated disposal.
*
* ```ts no_run
* import { topic } from 'fino:context/topic';
*
* const handle = topic('logs').subscribe((line) => console.log(line));
* handle.dispose();
* ```
*/
export class SubscriptionHandle {
  /**
  * Removal callback captured at construction; invoked on every `dispose()`
  * call to detach the subscription from its owning topic.
  *
  * @internal
  */
  #dispose: () => void;
  /**
  * Create a subscription handle from a disposal callback.
  *
  * Application code normally receives handles from `Topic.subscribe()` or
  * `subscribeMatching()`. The callback is called every time `dispose()` is
  * invoked, so make custom callbacks idempotent.
  *
  * ```ts no_run
  * import { SubscriptionHandle } from 'fino:context/topic';
  *
  * const handle = new SubscriptionHandle(() => console.log('disposed'));
  * handle.dispose();
  * ```
  */
  constructor(disposeFn: () => void) {
    this.#dispose = disposeFn;
  }
  /**
  * Remove the subscription.
  *
  * Calling more than once is safe for handles created by this module. Custom
  * handles depend on the callback passed to the constructor.
  *
  * ```ts no_run
  * import { topic } from 'fino:context/topic';
  *
  * const handle = topic('events').subscribe(() => {});
  * handle.dispose();
  * ```
  */
  dispose(): void {
    this.#dispose();
  }
}
/**
* Disposable handle returned from context bindings.
*
* Disposing removes one registered binding from a topic. Other bindings and
* subscriptions remain active.
*
* ```ts no_run
* import { Context } from 'fino:context';
* import { topic } from 'fino:context/topic';
*
* const ctx = new Context<string>('trace');
* const handle = topic<{ trace: string }>('trace:event')
*   .bindContext(ctx, (event) => event.trace);
* handle.dispose();
* ```
*/
export class BindingHandle {
  /**
  * Removal callback captured at construction; invoked on every `dispose()`
  * call to detach the binding from its owning topic.
  *
  * @internal
  */
  #dispose: () => void;
  /**
  * Create a binding handle from a disposal callback.
  *
  * Application code normally receives handles from `Topic.bindContext()`.
  * Custom callbacks should be idempotent if callers may dispose repeatedly.
  *
  * ```ts no_run
  * import { BindingHandle } from 'fino:context/topic';
  *
  * const handle = new BindingHandle(() => console.log('unbound'));
  * handle.dispose();
  * ```
  */
  constructor(disposeFn: () => void) {
    this.#dispose = disposeFn;
  }
  /**
  * Remove the context binding.
  *
  * Calling more than once is safe for handles created by this module. After
  * disposal, future `Topic.runWithValue()` calls skip the removed binding.
  *
  * ```ts no_run
  * import { Context } from 'fino:context';
  * import { topic } from 'fino:context/topic';
  *
  * const ctx = new Context<string>('trace');
  * const handle = topic<string>('trace').bindContext(ctx, (trace) => trace);
  * handle.dispose();
  * ```
  */
  dispose(): void {
    this.#dispose();
  }
}
