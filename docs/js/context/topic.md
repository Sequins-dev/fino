# topic

fino:topic — Named pub/sub channels with Context binding.

A `Topic` is a named pub/sub channel. When a `Context` is bound to a Topic,
calling `topic.runWithValue(msg, fn)` automatically derives and installs the
bound context value for the duration of `fn`. This separates the concerns of
*publishing* (the library/framework) from *consuming* context (application code).

```ts
import { topic } from './topic.mts';
import { Context } from 'fino:context';

const requestCtx = new Context('request');
const httpTopic = topic('http.request');

httpTopic.bindContext(requestCtx, (req) => req);

// In a handler:
httpTopic.runWithValue(request, () => {
  // requestCtx.get() === request here, and in any awaited code
  handleRequest();
});
```

## topic

```ts
function topic<T = unknown>(name: string): Topic<T>
```

Get or create a named `Topic`. Topics with the same name share state across
all imports — useful for cross-cutting bindings between libraries.

## subscribeMatching

```ts
function subscribeMatching<T = unknown>( matcher: (name: string) => boolean, fn: (msg: T, topicName: string) => void, ): SubscriptionHandle
```

Subscribe to all existing and future topics whose names match `matcher`.

Returns a handle that removes every attached subscription when disposed.

## Topic

```ts
class Topic<T = unknown> {
```

Named publish/subscribe channel that can bind messages into async contexts.

### constructor

```ts
constructor(name: string)
```

### name

```ts
get name(): string
```

The topic name (readonly).

### hasSubscribers

```ts
get hasSubscribers(): boolean
```

`true` if there are any active subscribers.

### subscribe

```ts
subscribe(fn: (msg: T) => void): SubscriptionHandle
```

Register a subscriber callback. Returns a `SubscriptionHandle` with a
`dispose()` method to remove the subscription.

The same function can be subscribed multiple times; each call returns an
independent handle.

### unsubscribe

```ts
unsubscribe(handle: SubscriptionHandle): void
```

Remove a subscription via its handle.

### publish

```ts
publish(msg: T): void
```

Fire all subscribers with `msg`. Each subscriber runs in its own
try/catch; errors are forwarded to the `"execution-flow:error"` topic so
a failing subscriber never blocks delivery to others.

Note: does NOT enter bound context scopes. Use `runWithValue()` for that.

### bindContext

```ts
bindContext<C>(ctx: { runWithValue<R>(val: C, fn: () => R): R }, transform: (msg: T) => C): BindingHandle
```

Declare that when this topic fires via `runWithValue()`, `ctx` should
be set to `transform(msg)` for the duration of the call. Multiple bindings
are entered in registration order (outermost first) and restored in reverse.

### unbindContext

```ts
unbindContext(handle: BindingHandle): void
```

Remove a context binding via its handle.

### runWithValue

```ts
runWithValue<R>(msg: T, fn: () => R): R
```

Enter all bound context scopes (in registration order), publish `msg` to
subscribers, then run `fn` — all within those scopes. Context values are
derived by calling each binding's `transform(msg)`. Scopes are restored in
reverse order after `fn` returns or throws.

## SubscriptionHandle

```ts
class SubscriptionHandle {
```

Disposable handle returned from topic subscriptions.

### constructor

```ts
constructor(disposeFn: () => void)
```

### dispose

```ts
dispose(): void
```

Remove the subscription; calling more than once is safe for current implementations.

## BindingHandle

```ts
class BindingHandle {
```

Disposable handle returned from context bindings.

### constructor

```ts
constructor(disposeFn: () => void)
```

### dispose

```ts
dispose(): void
```

Remove the context binding; calling more than once is safe for current implementations.
